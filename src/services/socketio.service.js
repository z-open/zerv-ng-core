
/** 
 * This service allows your application contact the websocket api.
 * 
 * It will ensure that the connection is available and user is authenticated before fetching data.
 * 
 */
angular
    .module('zerv.core')
    .provider('$socketio', socketioProvider);

function socketioProvider() {
    let debug;
    let defaultMaxAttempts;
    let defaultTimeoutInSecs;
    const transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : {serialize: noop, deserialize: noop};
    function noop(v) {
        return v;
    }

    this.setDebug = function(value) {
        debug = value;
        return this;
    };

    /**
     * Set how many attempts a fetch will happen by default
     * 
     * The number of attemps might not be reached during a fetch if the timeout kicks in first
     * 
     * @param {Number} value 
     */
    this.setDefaultMaxAttemps = (value) => {
        defaultMaxAttempts = value !== 0 ? value : Infinity;
        logDebug(() => 'set defaultMaxAttempts to ' + defaultMaxAttempts);
        return this;
    }

    /**
     * Set the maximum time a fetch can take to complete before timing out 
     * 
     * Even though the fetch might be attempted mulitiple times meanwhile.
     * 
     * 
     * @param {Number} value 
     */
    this.setDefaultTimeoutInSecs = (value) => {
        defaultTimeoutInSecs = value !== 0 ? value : Infinity;
        logDebug(() => 'set defaultTimeoutInSecs to ' + defaultTimeoutInSecs);
        return this;
    }

    this.getDefautMaxAttempts = () => defaultMaxAttempts;

    this.getDefaultMaxTimeout = () => defaultTimeoutInSecs;

    this.setDefaultMaxAttemps(3);
    this.setDefaultTimeoutInSecs(60);

    this.$get = function socketioService($rootScope, $q, $auth) {
        return {
            on: on,
            emit: emit,
            logout: $auth.logout,
            fetch: fetch,
            post: post,
            notify: notify,
        };

        // /////////////////
        function on(eventName, callback) {
            $auth.connect().then(function(socket) {
                socket.on(eventName, function() {
                    const args = arguments;
                    $rootScope.$apply(function() {
                        callback.apply(socket, args);
                    });
                });
            });
        }
        // deprecated, use post/notify
        function emit(eventName, data, callback) {
            $auth.connect().then(function(socket) {
                socket.emit(eventName, data, function() {
                    const args = arguments;
                    $rootScope.$apply(function() {
                        if (callback) {
                            callback.apply(socket, args);
                        }
                    });
                });
            });
        }

        /**
         * fetch data the way we call an api 
         * http://stackoverflow.com/questions/20685208/websocket-transport-reliability-socket-io-data-loss-during-reconnection
         * 
         */
        function fetch(operation, data, options = {}) {
            // it is very important to define the timeout
            // fetching lots of data might take time for some api call, timeout shoud be increased
            // after the timeout passes system will retry;
            return socketEmit(operation, data, 'fetch', options);
        }

        /**
         * notify is similar to fetch but more meaningful
         */
        function notify(operation, data, options = {}) {
            return socketEmit(operation, data, 'notify', options);
        }

        /**
         * post sends data to the server in order to modify data.
         * 
         * There is no guarantee that the post made it to the server if it times out
         * Currenlty, this will not retry in case of network failure to avoid posting multiple times the same data.
         * 
         */
        function post(operation, data, options = {}) {
            const lowerCase = operation.toLowerCase();
            // the fetch retries, usually not the post. is the developper using the right function?
            if (_.find(['.get', '.is', 'fetch', 'find'], (kw) => lowerCase.indexOf(kw) !== -1)) {
                console.warn(`IO(warn): ${operation} seems to be a fetch, but function post is used. Modify operation name or use function fetch.`);
            }
            // By default, there is no timeout and trying only once
            // the calling function should deal with the retry
            // if the operation never returns or adjust the option with timeout/attempts.
            options = _.assign({attempts:1, timeout: Infinity}, options);
            return socketEmit(operation, data, 'post', options);
        }

        /**
         * This function wraps the level socket emit function which is not re-emitting the data by itself currently.
         * 
         * If the emit fails and option.attempts is set, it will retry as soon as the network detected available (with no wait time)
         * A timeout prevents to wait eternally if the network never comes back
         * 
         * @param {String} operation 
         * @param {Object} data 
         * @param {Option} options 
         * 
         * @returns {Promise} the result from the api call
         */
        function socketEmit(operation, data, type, options = {}) {
            const serialized = transport.serialize(data);
            const deferred = $q.defer();
            const emitMaxAttempts = options.attempts || defaultMaxAttempts;
            const emitTimeoutInSecs = options.timeout || defaultTimeoutInSecs;
            let timeoutHandler;
            let listener;
            // system is believed to be connected
            if (emitTimeoutInSecs !== Infinity && _.isNumber(emitTimeoutInSecs)) {
                // if times out, it means there is too much slowness or processing and it might be better UX to give up and release resources
                // ex that can trigger timeout:
                // 1. ui execute socket emit and wait
                // 2. ui executes lots of processing (large loop, or many promises to get execute first)
                // 3. then emit might NOT process the response due to step 2 took too much time. socketEmit will timeout
                // and warn the user that there is connectivity issue and should manually retry.
                // but at least the user would understand that the data might not be updated.
                timeoutHandler = setTimeout(() => {
                    const result = {code: 'EMIT_TIMEOUT', description: `Failed to emit [${type}/${operation}] or process response - Network or browser too busy - timed out after ${emitTimeoutInSecs} and ${attemptNb} attempt(s)`};
                    logDebug(() => `Error on [${type}/${operation}] ->` + JSON.stringify(result));
                    deferred.reject({code: result.code, description: result.data});
                }, emitTimeoutInSecs * 1000);
            }
            const startTime = Date.now();
            let attemptNb = 1;
            $auth
                .connect()
                .then(handleEmitAttempts)
                // if the connection layer could connect, no need to try emit at all.
                // (Or could we rely on the emit timout instead?)
                .catch(onConnectionError);

            return deferred.promise
                .finally(() => {
                    if (listener) {
                        // there is no longer a need to listen for connection, since the promise completed
                        listener();
                    }
                })

            function handleEmitAttempts(socket) {
                // socket is supposed to be successfully connected at this point (but it is never a guarantee)
                if (emitMaxAttempts > 1) {
                    // if socket disconnects and reconnects during the emit
                    // the emit will most likely not make it or acknowledge (Remember -> emit never throws error)
                    // On reconnect, let's emit again
                    // but we just don't know when connection might come back, socketio is trying in the background.
                    // Timeout might kick in at some point to cancel the operation
                    listener = $auth.addConnectionListener(() => {
                        // system just reconnected
                        // let's emit again
                        if (emitMaxAttempts > ++attemptNb) {
                            emitData(socket);
                        } else {
                            const result = { code: 'EMIT_RETRY_ERR', description: `Failed to emit to [${type}/${operation}] or process response - Made ${attemptNb} attempt(s)` };
                            logDebug(() => `Error on [${type}/${operation}] ->` + JSON.stringify(result));
                            deferred.reject({ code: result.code, description: result.data });
                        }
                    });
                }
                emitData(socket);
            }
        
            function onConnectionError(err) {
                clearTimeout(timeoutHandler);
                const result = {code: 'CONNECTION_ERR', description: err};
                logDebug(() => `Error on  [${type}/${operation}] ->` + JSON.stringify(result));
                deferred.reject(result);
            }

            function emitData(socket) {
                logDebug(() => `socket emitting compressed data [${ getJsonSize(serialized) }] to [${type}/${operation}] - attempt ${attemptNb}/${emitMaxAttempts}`);

                socket.emit('api', operation, serialized, function(serializedResult) {
                    clearTimeout(timeoutHandler);
                    const dataReceivedIn = Date.now() - startTime;
                    debug && console.debug(`IO(debug): Received compressed data [${ getJsonSize(serializedResult) }] from [${type}/${operation}] in ${dataReceivedIn.toFixed(0)}ms and ${attemptNb} attempt(s)`);
                    const result = transport.deserialize(serializedResult);

                    if (result.code) {
                        logDebug(() => `Error emitting [${type}/${operation}] ->` + JSON.stringify(result));
                        deferred.reject({code: result.code, description: result.data});
                    } else {
                        deferred.resolve(result.data);
                    }
                });
            }
        }
    };

    function getJsonSize(obj) {
        if (_.isNil(obj)) {
            return 'none';
        }
        return formatSize(JSON.stringify(obj).length) ;
    }

    function formatSize(size) {
        return size > 1000000 ? roundNumber(size / 1000000, 3) + 'Mgb' : size > 1000 ? roundNumber(size / 1000, 3) + 'Kb' : roundNumber(size) + 'b';
    }

    function roundNumber(num, n) {
        if (!n) {
            return Math.round(num);
        }
        const d = Math.pow(10, n);
        return Math.round(num * d) / d;
    }

    function logDebug(msg) {
        if (!debug) {
            return;
        }
        if (_.isFunction(msg)) {
            console.debug('IO(debug): ' + msg());
        } else {
            // not recommended, if msg is concatenation
            console.debug('IO(debug): ' + msg);
        }
    }
}


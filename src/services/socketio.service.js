
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
    let defaultMaxAttempts = 3;
    let defaultTimeout = 30;
    const transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : {serialize: noop, deserialize: noop};
    function noop(v) {
        return v;
    }

    this.setDebug = function(value) {
        debug = value;
    };

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
            if (debug) {
                console.debug('IO(debug): Fetching ' + operation + '...');
            }
            // it is very important to define the timeout
            // fetching lots of data might take time for some api call, timeout shoud be increased
            // after the timeout passes system will retry;
            return socketEmit(operation, data, options);
        }

        /**
         * notify is similar to fetch but more meaningful
         */
        function notify(operation, data, options = {}) {
            if (debug) {
                console.debug('IO(debug): Notifying ' + operation + '...');
            }
            return socketEmit(operation, data, options);
        }

        /**
         * post sends data to the server.
         * if data was already submitted, it would just return - which could happen when handling disconnection.
         * 
         */
        function post(operation, data) {
            if (debug) {
                console.debug('IO(debug): Posting ' + operation + '...');
            }
            // there is no timeout
            // the calling function should deal with the retry
            // if the operation never returns.
            return socketEmit(operation, data, {attempts:1, timeout: Infinity});
        }

        function socketEmit(operation, data, options = {}) {
            const serialized = transport.serialize(data);

            return $auth.connect()
                .then(onConnectionSuccess, onConnectionError);

            

            function onConnectionSuccess(socket) {
                const deferred = $q.defer();
                const maxAttempt = options.attempts || defaultMaxAttempts;
                const timeoutInSecs = options.timeout || defaultTimeout;
                // the connection is supposed to be established
                // if not, during the process of the emit, it will fail
                // the emit will never receive the ack
                // data might have arrived, not sure
                // this could be stamped
                // and retry anyway
                emit(1);

                function emit(attemptNb) {
                    let timeoutHandler;
                    if (timeoutInSecs !== Infinity && _.isNumber(timeoutInSecs))
                        timeoutHandler = setTimeout(() => {
                        if (maxAttempt > attemptNb) {
                            // most likely the connection was lost right before emit..
                            socket.connect();
                            emit(++attemptNb);
                        } else {
                            const result = {code: 'EMIT_TIMEOUT', description: 'Failed to emit '+ operation};
                            debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                            deferred.reject({code: result.code, description: result.data});
                        }
                    }, timeoutInSecs * 1000);

                    debug && console.debug(`IO(debug): socket emitting ${operation} - attempt ${attemptNb}/${maxAttempt}`);

                    socket.emit('api', operation, serialized, function(serializedResult) {
                        clearTimeout(timeoutHandler);
                        if (debug) {
                            console.debug('IO(debug): ACKed socketEmit ' + operation);
                        }
                        const result = transport.deserialize(serializedResult);

                        if (result.code) {
                            debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                            deferred.reject({code: result.code, description: result.data});
                        } else {
                            deferred.resolve(result.data);
                        }
                    });
                }

                return deferred.promise;
            }

            function onConnectionError(err) {
                const result = {code: 'CONNECTION_ERR', description: err};
                debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                return $q.reject(result);
            }
        }
    };
}


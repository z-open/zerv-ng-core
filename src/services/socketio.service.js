
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
         * post sends data to the server in order to modify data.
         * 
         * There is no guarantee that the post made it to the server if it times out
         * Currenlty, this will not retry in case of network failure to avoid posting multiple times the same data.
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
        function socketEmit(operation, data, options = {}) {
            const serialized = transport.serialize(data);
            const deferred = $q.defer();
            let attemptNb = 1;
            const maxAttempt = options.attempts || defaultMaxAttempts;
            const timeoutInSecs = 240 || options.timeout || defaultTimeout;
            let timeoutHandler;
            let listener;
            // system is believed to be connected
            if (timeoutInSecs !== Infinity && _.isNumber(timeoutInSecs)) {
                // if times out, it means there is too much slowness or processing and it might be better UX to give up and release resources
                // ex that can trigger timeout:
                // 1. ui execute socket emit and wait
                // 2. ui executes lots of processing (large loop, or many promises to get execute first)
                // 3. then emit might NOT process the response due to step 2 took too much time. socketEmit will timeout
                // and warn the user that there is connectivity issue and should manually retry.
                // but at least the user would understand that the data might not be updated.
                timeoutHandler = setTimeout(() => {
                    const result = {code: 'EMIT_TIMEOUT', description: `Failed to emit [${operation}] or process response - Network or browser too busy - timed out after ${timeoutInSecs} and ${attemptNb} attempt(s)`};
                    debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                    deferred.reject({code: result.code, description: result.data});
                }, timeoutInSecs * 1000);
            }
            const startTime = Date.now();
            $auth
                .connect()
                .then((socket) => {
                    // socket is successfully connected
                    if (maxAttempt > 1) {
                        // if socket disconnects and reconnects during the emit
                        // the emit will most likely not make it and acknowledge (emit never throws error)
                        // On reconnect, let's emit again
                        // but we just don't know when connection might come back, socketio is trying in the background.
                        // Timeout might kick in at some point to cancel the operation
                        listener = $auth.addConnectionListener(() => {
                            // system just reconnected
                            // let's emit again
                            if (maxAttempt > ++attemptNb) {
                                emit(socket);
                            } else {
                                const result = {code: 'EMIT_RETRY_ERR', description: `Failed to emit to [${operation}] or process response - Made ${attemptNb} attempt(s)`};
                                debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                                deferred.reject({code: result.code, description: result.data});
                            }
                        });
                    }
                    emit(socket);
                })
                .catch((err) => {
                    // if the connection layer could connect, no need to try emit.
                    clearTimeout(timeoutHandler);
                    const result = {code: 'CONNECTION_ERR', description: err};
                    debug && console.debug('IO(debug): Error on [' + operation + '] ->' + JSON.stringify(result));
                    deferred.reject(result);
                });

            return deferred.promise
                .finally(() => {
                    if (listener) {
                        // there is no longer a need to listen for connection, since the promise completed
                        listener();
                    }
                })

            function emit(socket) {
                debug && console.debug(`IO(debug): socket emitting compressed data [${ getJsonSize(serialized) }] to [${operation}] - attempt ${attemptNb}/${maxAttempt}`);

                socket.emit('api', operation, serialized, function(serializedResult) {
                    clearTimeout(timeoutHandler);
                    const dataReceivedIn = Date.now() - startTime;
                    debug && console.debug(`IO(debug): Received compressed data [${ getJsonSize(serializedResult) }] from [${operation}] in ${dataReceivedIn.toFixed(0)}ms and ${attemptNb} attempt(s)`);
                    const result = transport.deserialize(serializedResult);

                    if (result.code) {
                        debug && console.debug('IO(debug): Error emitting [' + operation + '] ->' + JSON.stringify(result));
                        deferred.reject({code: result.code, description: result.data});
                    } else {
                        deferred.resolve(result.data);
                    }
                });
            }


        }

        // function socketEmit2(operation, data, options = {}) {
        //     const serialized = transport.serialize(data);

        //     return $auth.connect()
        //         .then(onConnectionSuccess, onConnectionError);

            

        //     function onConnectionSuccess(socket) {
        //         const deferred = $q.defer();
        //         const maxAttempt = options.attempts || defaultMaxAttempts;
        //         const timeoutInSecs = options.timeout || defaultTimeout;
        //         // the connection is supposed to be established
        //         // if not, during the process of the emit, it will fail
        //         // the emit will never receive the ack
        //         // data might have arrived, not sure
        //         // this could be stamped
        //         // and retry anyway
        //         emit(1);

        //         function emit(attemptNb) {
        //             let timeoutHandler;
        //             if (timeoutInSecs !== Infinity && _.isNumber(timeoutInSecs))
        //                 timeoutHandler = setTimeout(() => {
        //                 if (maxAttempt > attemptNb) {
        //                     // most likely the connection was lost right before emit..
        //                     socket.connect();
        //                     emit(++attemptNb);
        //                 } else {
        //                     const result = {code: 'EMIT_TIMEOUT', description: 'Failed to emit '+ operation};
        //                     debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
        //                     deferred.reject({code: result.code, description: result.data});
        //                 }
        //             }, timeoutInSecs * 1000);

        //             debug && console.debug(`IO(debug): socket emitting ${operation} - attempt ${attemptNb}/${maxAttempt}`);

        //             socket.emit('api', operation, serialized, function(serializedResult) {
        //                 clearTimeout(timeoutHandler);
        //                 if (debug) {
        //                     console.debug('IO(debug): ACKed socketEmit ' + operation);
        //                 }
        //                 const result = transport.deserialize(serializedResult);

        //                 if (result.code) {
        //                     debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
        //                     deferred.reject({code: result.code, description: result.data});
        //                 } else {
        //                     deferred.resolve(result.data);
        //                 }
        //             });
        //         }

        //         return deferred.promise;
        //     }

        //     function onConnectionError(err) {
        //         const result = {code: 'CONNECTION_ERR', description: err};
        //         debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
        //         return $q.reject(result);
        //     }
        // }
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
}


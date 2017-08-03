
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
    var debug;
    var transport = window.ZJSONBIN || { serialize: noop, deserialize: noop };
    function noop(v) {
        return v;
    }

    this.setDebug = function (value) {
        debug = value;
    };

    this.$get = function socketioService($rootScope, $q, $auth) {

        return {
            on: on,
            emit: emit,
            logout: $auth.logout,
            fetch: fetch,
            post: post,
            notify: notify
        };

        ///////////////////
        function on(eventName, callback) {
            $auth.connect().then(function (socket) {
                socket.on(eventName, function () {
                    var args = arguments;
                    $rootScope.$apply(function () {
                        callback.apply(socket, args);
                    });
                });
            });
        }
        // deprecated, use post/notify
        function emit(eventName, data, callback) {
            $auth.connect().then(function (socket) {
                socket.emit(eventName, data, function () {
                    var args = arguments;
                    $rootScope.$apply(function () {
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
        function fetch(operation, data) {
            if (debug) { console.debug('Fetching ' + operation + '...'); }
            return socketEmit(operation, data)
        }

        /**
         * notify is similar to fetch but more meaningful
         */
        function notify(operation, data) {
            if (debug) { console.debug('Notifying ' + operation + '...'); }
            return socketEmit(operation, data)
        }

        /**
         * post sends data to the server.
         * if data was already submitted, it would just return - which could happen when handling disconnection.
         * 
         */
        function post(operation, data) {
            if (debug) { console.debug('Posting ' + operation + '...'); }
            return socketEmit(operation, data);
        }

        function socketEmit(operation, data) {
            var serialized = transport.serialize(data);

            return $auth.connect()
                .then(onConnectionSuccess, onConnectionError)
                ;// .catch(onConnectionError);

            ////////////
            function onConnectionSuccess(socket) {
                var deferred = $q.defer();
                socket.emit('api', operation, serialized, function (serializedResult) {
                    const result = transport.deserialize(serializedResult);

                    if (result.code) {
                        debug && console.debug('Error on ' + operation + ' ->' + JSON.stringify(result));
                        deferred.reject({ code: result.code, description: result.data });
                    }
                    else {
                        deferred.resolve(result.data);
                    }
                });
                return deferred.promise;
            }

            function onConnectionError(err) {
                return $q.reject({ code: 'CONNECTION_ERR', description: err });
            }
        }
    }
}


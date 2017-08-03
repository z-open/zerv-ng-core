(function() {
"use strict";

angular.module('zerv.core', []);
}());

(function() {
"use strict";

/** 
 * This provider handles the handshake to authenticate a user and maintain a secure web socket connection via tokens.
 * It also sets the login and logout url participating in the authentication.
 * 
 * 
 * usage examples:
 * 
 * In the config of the app module:
 * socketServiceProvider.setLoginUrl('/access#/login');
 * socketServiceProvider.setLogoutUrl('/access#/login');
 * socketServiceProvider.setReconnectionMaxTimeInSecs(15);
 * This defines how much time we can wait to establish a successul connection before rejecting the connection (socketService.connectIO) with a timeout. by default, it will try for 15 seconds to get a connection and then give up
 *  
 * Before any socket use in your services or resolve blocks, connect() makes sure that we have an established authenticated connection by using the following:
 * socketService.connect().then(
 * function(socket){ ... socket.emit().. }).catch(function(err) {...})
 * 
 * 
 */
angular
    .module('zerv.core')
    // convenient service returning sessionUser
    .factory('sessionUser', ["$auth", function($auth) {
        return $auth.getSessionUser();
    }])
    .provider('$auth', authProvider);

function authProvider() {
    var loginUrl, logoutUrl, debug, reconnectionMaxTime = 15;

    this.setDebug = function(value) {
        debug = value;
    };

    this.setLoginUrl = function(value) {
        loginUrl = value;
    };

    this.setLogoutUrl = function(value) {
        logoutUrl = value;
    };

    this.setReconnectionMaxTimeInSecs = function(value) {
        reconnectionMaxTime = value * 1000;
    };

    this.$get = ["$rootScope", "$location", "$timeout", "$q", "$window", function($rootScope, $location, $timeout, $q, $window) {
        var socket;
        var userToken = retrieveToken();
        var sessionUser = {connected: false};

        if (!userToken) {
            // @TODO: this right way to redirect if we have no token when we refresh or hit the app.
            //  redirect(loginUrl);
            // but it would prevent most unit tests from running because this module is tighly coupled with all unit tests (depends on it)at this time :

        } else {
            localStorage.token = userToken;
        }
        return {
            connect: connect,
            logout: logout,
            getSessionUser: getSessionUser,
        };


        // /////////////////

        function getSessionUser() {
            // the object will have the user information when the connection is established. Otherwise its connection property will be false; 
            return sessionUser;
        }

        /**
         * returns a promise 
         * the success function receives the socket as a parameter
         */
        function connect() {
            if (!socket) {
                setup();
            }
            return getForValidConnection();
        }

        function logout() {
            // connection could be lost during logout..so it could mean we have not logout on server side.
            if (socket) {
                socket.emit('logout', userToken);
            }
        }

        function getForValidConnection() {
            var deferred = $q.defer();
            if (sessionUser.connected) {
                deferred.resolve(socket);
            } else {
                // being the scene, socket.io is trying to reconnect and authenticate if the connection was lost;
                reconnect().then(function() {
                    deferred.resolve(socket);
                }).catch(function(err) {
                    deferred.reject('USER_NOT_CONNECTED');
                });
            }
            return deferred.promise;
        }

        function reconnect() {
            var deferred = $q.defer();

            if (sessionUser.connected) {
                deferred.resolve(socket);
            }
            // @TODO TO THINK ABOUT:, if the socket is connecting already, means that a connect was called already by another async call, so just wait for user_connected


            // if the response does not come quick..let's give up so we don't get stuck waiting
            // @TODO:other way is to watch for a connection error...
            var acceptableDelay;
            var off = $rootScope.$on('user_connected', function() {
                off();
                if (acceptableDelay) {
                    $timeout.cancel(acceptableDelay);
                }
                deferred.resolve(socket);
            });

            acceptableDelay = $timeout(function() {
                off();
                deferred.reject('TIMEOUT');
            }, reconnectionMaxTime);

            return deferred.promise;
        }

        function setup() {
            if (socket) {
                // already called...
                return;
            }
            var tokenValidityTimeout;
            // establish connection without passing the token (so that it is not visible in the log)
            socket = io.connect({
                'forceNew': true,
            });

            socket
                .on('connect', onConnect)
                .on('authenticated', onAuthenticated)
                .on('unauthorized', onUnauthorized)
                .on('logged_out', onLogOut)
                .on('disconnect', onDisconnect);

            // TODO: this followowing event is still used.???....
            socket
                .on('connect_error', function() {
                    setConnectionStatus(false);
                });

            // ///////////////////////////////////////////
            function onConnect() {
                // the socket is connected, time to pass the token to authenticate asap
                // because the token is about to expire...if it expires we will have to relog in
                setConnectionStatus(false);
                socket.emit('authenticate', {token: userToken}); // send the jwt
            }

            function onDisconnect() {
                if (debug) {
                    console.debug('Session disconnected');
                }
                setConnectionStatus(false);
                $rootScope.$broadcast('user_disconnected');
            }

            function onAuthenticated(refreshToken) {
                clearTokenTimeout();
                // the server confirmed that the token is valid...we are good to go
                if (debug) {
                    console.debug('authenticated, received new token: ' + (refreshToken != userToken));
                }
                localStorage.token = refreshToken;
                userToken = refreshToken;
                setLoginUser(userToken);
                setConnectionStatus(true);
                requestNewTokenBeforeExpiration(userToken);
                $rootScope.$broadcast('user_connected', sessionUser);
            }

            function onLogOut() {
                clearTokenTimeout();
                // token is no longer available.
                delete localStorage.token;
                setConnectionStatus(false);
                redirect(logoutUrl || loginUrl);
            }

            function onUnauthorized(msg) {
                clearTokenTimeout();
                if (debug) {
                    console.debug('unauthorized: ' + JSON.stringify(msg.data));
                }
                setConnectionStatus(false);
                redirect(loginUrl);
            }

            function setConnectionStatus(connected) {
                sessionUser.connected = connected;
                // console.debug("Connection status:" + JSON.stringify(sessionUser));
            }

            function setLoginUser(token) {
                var payload = decode(token);
                return _.assign(sessionUser, payload);
            }

            function clearTokenTimeout() {
                if (tokenValidityTimeout) {
                    $timeout.cancel(tokenValidityTimeout);
                }
            }

            function decode(token) {
                var base64Url = token.split('.')[1];
                var base64 = base64Url.replace('-', '+').replace('_', '/');
                var payload = JSON.parse($window.atob(base64));
                return payload;
            }

            function requestNewTokenBeforeExpiration(token) {
                // request a little before...
                var payload = decode(token, {complete: false});

                var initial = payload.dur;

                var duration = (initial * 90 / 100) | 0;
                if (debug) {
                    console.debug('Schedule to request a new token in ' + duration + ' seconds (token duration:' + initial + ')');
                }
                tokenValidityTimeout = $timeout(function() {
                    if (debug) {
                        console.debug('Time to request new token ' + initial);
                    }
                    socket.emit('authenticate', {token: token});
                    // Note: If communication crashes right after we emitted and when servers is sending back the token,
                    // when the client reestablishes the connection, we would have to login because the previous token would be invalidated.
                }, duration * 1000);
            }
        }

        function retrieveToken() {
            var userToken = $location.search().token;
            if (userToken) {
                if (debug) {
                    console.debug('Using token passed during redirection: ' + userToken);
                }
            } else {
                userToken = localStorage.token;
                if (userToken) {
                    if (debug) {
                        console.debug('Using Token in local storage: ' + userToken);
                    }
                } else {

                }
            }
            return userToken;
        }

        function redirect(url) {
            window.location.replace(url || 'badUrl.html');
        }
    }];
}
}());

(function() {
"use strict";

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
    var transport = window.ZJSONBIN || {serialize: noop, deserialize: noop};
    function noop(v) {
        return v;
    }

    this.setDebug = function(value) {
        debug = value;
    };

    this.$get = ["$rootScope", "$q", "$auth", function socketioService($rootScope, $q, $auth) {
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
                    var args = arguments;
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
                    var args = arguments;
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
        function fetch(operation, data) {
            if (debug) {
                console.debug('Fetching ' + operation + '...');
            }
            return socketEmit(operation, data);
        }

        /**
         * notify is similar to fetch but more meaningful
         */
        function notify(operation, data) {
            if (debug) {
                console.debug('Notifying ' + operation + '...');
            }
            return socketEmit(operation, data);
        }

        /**
         * post sends data to the server.
         * if data was already submitted, it would just return - which could happen when handling disconnection.
         * 
         */
        function post(operation, data) {
            if (debug) {
                console.debug('Posting ' + operation + '...');
            }
            return socketEmit(operation, data);
        }

        function socketEmit(operation, data) {
            var serialized = transport.serialize(data);

            return $auth.connect()
                .then(onConnectionSuccess, onConnectionError)
                ;// .catch(onConnectionError);

            // //////////
            function onConnectionSuccess(socket) {
                var deferred = $q.defer();
                socket.emit('api', operation, serialized, function(serializedResult) {
                    var result = transport.deserialize(serializedResult);

                    if (result.code) {
                        debug && console.debug('Error on ' + operation + ' ->' + JSON.stringify(result));
                        deferred.reject({code: result.code, description: result.data});
                    } else {
                        deferred.resolve(result.data);
                    }
                });
                return deferred.promise;
            }

            function onConnectionError(err) {
                return $q.reject({code: 'CONNECTION_ERR', description: err});
            }
        }
    }];
}
}());


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInplcnYtbmctY29yZS5qcyIsInNvY2tldC5tb2R1bGUuanMiLCJzZXJ2aWNlcy9hdXRoLnNlcnZpY2UuanMiLCJzZXJ2aWNlcy9zb2NrZXRpby5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBLFFBQUEsT0FBQSxhQUFBOzs7QURNQSxDQUFDLFdBQVc7QUFDWjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FFYUE7S0FDQSxPQUFBOztLQUVBLFFBQUEseUJBQUEsU0FBQSxPQUFBO1FBQ0EsT0FBQSxNQUFBOztLQUVBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7SUFDQSxJQUFBLFVBQUEsV0FBQSxPQUFBLHNCQUFBOztJQUVBLEtBQUEsV0FBQSxTQUFBLE9BQUE7UUFDQSxRQUFBOzs7SUFHQSxLQUFBLGNBQUEsU0FBQSxPQUFBO1FBQ0EsV0FBQTs7O0lBR0EsS0FBQSxlQUFBLFNBQUEsT0FBQTtRQUNBLFlBQUE7OztJQUdBLEtBQUEsK0JBQUEsU0FBQSxPQUFBO1FBQ0Esc0JBQUEsUUFBQTs7O0lBR0EsS0FBQSxnRUFBQSxTQUFBLFlBQUEsV0FBQSxVQUFBLElBQUEsU0FBQTtRQUNBLElBQUE7UUFDQSxJQUFBLFlBQUE7UUFDQSxJQUFBLGNBQUEsQ0FBQSxXQUFBOztRQUVBLElBQUEsQ0FBQSxXQUFBOzs7OztlQUtBO1lBQ0EsYUFBQSxRQUFBOztRQUVBLE9BQUE7WUFDQSxTQUFBO1lBQ0EsUUFBQTtZQUNBLGdCQUFBOzs7Ozs7UUFNQSxTQUFBLGlCQUFBOztZQUVBLE9BQUE7Ozs7Ozs7UUFPQSxTQUFBLFVBQUE7WUFDQSxJQUFBLENBQUEsUUFBQTtnQkFDQTs7WUFFQSxPQUFBOzs7UUFHQSxTQUFBLFNBQUE7O1lBRUEsSUFBQSxRQUFBO2dCQUNBLE9BQUEsS0FBQSxVQUFBOzs7O1FBSUEsU0FBQSx3QkFBQTtZQUNBLElBQUEsV0FBQSxHQUFBO1lBQ0EsSUFBQSxZQUFBLFdBQUE7Z0JBQ0EsU0FBQSxR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QUFBLEtBQUEsV0FBQSxNQUFBO1lBQ0EsSUFBQSxPQUFBO2dCQUNBLFFBQUEsTUFBQSxhQUFBLFlBQUE7O1lBRUEsT0FBQSxXQUFBLFdBQUE7OztRQUdBLFNBQUEsV0FBQSxXQUFBLE1BQUE7WUFDQSxJQUFBLGFBQUEsVUFBQSxVQUFBOztZQUVBLE9BQUEsTUFBQTtpQkFDQSxLQUFBLHFCQUFBOzs7O1lBSUEsU0FBQSxvQkFBQSxRQUFBO2dCQUNBLElBQUEsV0FBQSxHQUFBO2dCQUNBLE9BQUEsS0FBQSxPQUFBLFdBQUEsWUFBQSxTQUFBLGtCQUFBO29CQUNBLElBQUEsU0FBQSxVQUFBLFlBQUE7O29CQUVBLElBQUEsT0FBQSxNQUFBO3dCQUNBLFNBQUEsUUFBQSxNQUFBLGNBQUEsWUFBQSxRQUFBLEtBQUEsVUFBQTt3QkFDQSxTQUFBLE9BQUEsQ0FBQSxNQUFBLE9BQUEsTUFBQSxhQUFBLE9BQUE7MkJBQ0E7d0JBQ0EsU0FBQSxRQUFBLE9BQUE7OztnQkFHQSxPQUFBLFNBQUE7OztZQUdBLFNBQUEsa0JBQUEsS0FBQTtnQkFDQSxPQUFBLEdBQUEsT0FBQSxDQUFBLE1BQUEsa0JBQUEsYUFBQTs7Ozs7OztBSHFTQSIsImZpbGUiOiJ6ZXJ2LW5nLWNvcmUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhci5tb2R1bGUoJ3plcnYuY29yZScsIFtdKTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHByb3ZpZGVyIGhhbmRsZXMgdGhlIGhhbmRzaGFrZSB0byBhdXRoZW50aWNhdGUgYSB1c2VyIGFuZCBtYWludGFpbiBhIHNlY3VyZSB3ZWIgc29ja2V0IGNvbm5lY3Rpb24gdmlhIHRva2Vucy5cbiAqIEl0IGFsc28gc2V0cyB0aGUgbG9naW4gYW5kIGxvZ291dCB1cmwgcGFydGljaXBhdGluZyBpbiB0aGUgYXV0aGVudGljYXRpb24uXG4gKiBcbiAqIFxuICogdXNhZ2UgZXhhbXBsZXM6XG4gKiBcbiAqIEluIHRoZSBjb25maWcgb2YgdGhlIGFwcCBtb2R1bGU6XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9naW5VcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9nb3V0VXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MoMTUpO1xuICogVGhpcyBkZWZpbmVzIGhvdyBtdWNoIHRpbWUgd2UgY2FuIHdhaXQgdG8gZXN0YWJsaXNoIGEgc3VjY2Vzc3VsIGNvbm5lY3Rpb24gYmVmb3JlIHJlamVjdGluZyB0aGUgY29ubmVjdGlvbiAoc29ja2V0U2VydmljZS5jb25uZWN0SU8pIHdpdGggYSB0aW1lb3V0LiBieSBkZWZhdWx0LCBpdCB3aWxsIHRyeSBmb3IgMTUgc2Vjb25kcyB0byBnZXQgYSBjb25uZWN0aW9uIGFuZCB0aGVuIGdpdmUgdXBcbiAqICBcbiAqIEJlZm9yZSBhbnkgc29ja2V0IHVzZSBpbiB5b3VyIHNlcnZpY2VzIG9yIHJlc29sdmUgYmxvY2tzLCBjb25uZWN0KCkgbWFrZXMgc3VyZSB0aGF0IHdlIGhhdmUgYW4gZXN0YWJsaXNoZWQgYXV0aGVudGljYXRlZCBjb25uZWN0aW9uIGJ5IHVzaW5nIHRoZSBmb2xsb3dpbmc6XG4gKiBzb2NrZXRTZXJ2aWNlLmNvbm5lY3QoKS50aGVuKFxuICogZnVuY3Rpb24oc29ja2V0KXsgLi4uIHNvY2tldC5lbWl0KCkuLiB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHsuLi59KVxuICogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLy8gY29udmVuaWVudCBzZXJ2aWNlIHJldHVybmluZyBzZXNzaW9uVXNlclxuICAgIC5mYWN0b3J5KCdzZXNzaW9uVXNlcicsIGZ1bmN0aW9uKCRhdXRoKSB7XG4gICAgICAgIHJldHVybiAkYXV0aC5nZXRTZXNzaW9uVXNlcigpO1xuICAgIH0pXG4gICAgLnByb3ZpZGVyKCckYXV0aCcsIGF1dGhQcm92aWRlcik7XG5cbmZ1bmN0aW9uIGF1dGhQcm92aWRlcigpIHtcbiAgICB2YXIgbG9naW5VcmwsIGxvZ291dFVybCwgZGVidWcsIHJlY29ubmVjdGlvbk1heFRpbWUgPSAxNTtcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ2luVXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9naW5VcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dvdXRVcmwgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBsb2dvdXRVcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgcmVjb25uZWN0aW9uTWF4VGltZSA9IHZhbHVlICogMTAwMDtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24oJHJvb3RTY29wZSwgJGxvY2F0aW9uLCAkdGltZW91dCwgJHEsICR3aW5kb3cpIHtcbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgdmFyIHVzZXJUb2tlbiA9IHJldHJpZXZlVG9rZW4oKTtcbiAgICAgICAgdmFyIHNlc3Npb25Vc2VyID0ge2Nvbm5lY3RlZDogZmFsc2V9O1xuXG4gICAgICAgIGlmICghdXNlclRva2VuKSB7XG4gICAgICAgICAgICAvLyBAVE9ETzogdGhpcyByaWdodCB3YXkgdG8gcmVkaXJlY3QgaWYgd2UgaGF2ZSBubyB0b2tlbiB3aGVuIHdlIHJlZnJlc2ggb3IgaGl0IHRoZSBhcHAuXG4gICAgICAgICAgICAvLyAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IHdvdWxkIHByZXZlbnQgbW9zdCB1bml0IHRlc3RzIGZyb20gcnVubmluZyBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIHRpZ2hseSBjb3VwbGVkIHdpdGggYWxsIHVuaXQgdGVzdHMgKGRlcGVuZHMgb24gaXQpYXQgdGhpcyB0aW1lIDpcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gdXNlclRva2VuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0OiBjb25uZWN0LFxuICAgICAgICAgICAgbG9nb3V0OiBsb2dvdXQsXG4gICAgICAgICAgICBnZXRTZXNzaW9uVXNlcjogZ2V0U2Vzc2lvblVzZXIsXG4gICAgICAgIH07XG5cblxuICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGdldFNlc3Npb25Vc2VyKCkge1xuICAgICAgICAgICAgLy8gdGhlIG9iamVjdCB3aWxsIGhhdmUgdGhlIHVzZXIgaW5mb3JtYXRpb24gd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZC4gT3RoZXJ3aXNlIGl0cyBjb25uZWN0aW9uIHByb3BlcnR5IHdpbGwgYmUgZmFsc2U7IFxuICAgICAgICAgICAgcmV0dXJuIHNlc3Npb25Vc2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIFxuICAgICAgICAgKiB0aGUgc3VjY2VzcyBmdW5jdGlvbiByZWNlaXZlcyB0aGUgc29ja2V0IGFzIGEgcGFyYW1ldGVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBjb25uZWN0KCkge1xuICAgICAgICAgICAgaWYgKCFzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzZXR1cCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGdldEZvclZhbGlkQ29ubmVjdGlvbigpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbG9nb3V0KCkge1xuICAgICAgICAgICAgLy8gY29ubmVjdGlvbiBjb3VsZCBiZSBsb3N0IGR1cmluZyBsb2dvdXQuLnNvIGl0IGNvdWxkIG1lYW4gd2UgaGF2ZSBub3QgbG9nb3V0IG9uIHNlcnZlciBzaWRlLlxuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdsb2dvdXQnLCB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Rm9yVmFsaWRDb25uZWN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGJlaW5nIHRoZSBzY2VuZSwgc29ja2V0LmlvIGlzIHRyeWluZyB0byByZWNvbm5lY3QgYW5kIGF1dGhlbnRpY2F0ZSBpZiB0aGUgY29ubmVjdGlvbiB3YXMgbG9zdDtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVVNFUl9OT1RfQ09OTkVDVEVEJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlY29ubmVjdCgpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBAVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgdmFyIG9mZiA9ICRyb290U2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGlmIChhY2NlcHRhYmxlRGVsYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKGFjY2VwdGFibGVEZWxheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhY2NlcHRhYmxlRGVsYXkgPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH0sIHJlY29ubmVjdGlvbk1heFRpbWUpO1xuXG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwKCkge1xuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIC8vIGFscmVhZHkgY2FsbGVkLi4uXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIHRva2VuVmFsaWRpdHlUaW1lb3V0O1xuICAgICAgICAgICAgLy8gZXN0YWJsaXNoIGNvbm5lY3Rpb24gd2l0aG91dCBwYXNzaW5nIHRoZSB0b2tlbiAoc28gdGhhdCBpdCBpcyBub3QgdmlzaWJsZSBpbiB0aGUgbG9nKVxuICAgICAgICAgICAgc29ja2V0ID0gaW8uY29ubmVjdCh7XG4gICAgICAgICAgICAgICAgJ2ZvcmNlTmV3JzogdHJ1ZSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3QnLCBvbkNvbm5lY3QpXG4gICAgICAgICAgICAgICAgLm9uKCdhdXRoZW50aWNhdGVkJywgb25BdXRoZW50aWNhdGVkKVxuICAgICAgICAgICAgICAgIC5vbigndW5hdXRob3JpemVkJywgb25VbmF1dGhvcml6ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCdsb2dnZWRfb3V0Jywgb25Mb2dPdXQpXG4gICAgICAgICAgICAgICAgLm9uKCdkaXNjb25uZWN0Jywgb25EaXNjb25uZWN0KTtcblxuICAgICAgICAgICAgLy8gVE9ETzogdGhpcyBmb2xsb3dvd2luZyBldmVudCBpcyBzdGlsbCB1c2VkLj8/Py4uLi5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdF9lcnJvcicsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0KCkge1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzb2NrZXQgaXMgY29ubmVjdGVkLCB0aW1lIHRvIHBhc3MgdGhlIHRva2VuIHRvIGF1dGhlbnRpY2F0ZSBhc2FwXG4gICAgICAgICAgICAgICAgLy8gYmVjYXVzZSB0aGUgdG9rZW4gaXMgYWJvdXQgdG8gZXhwaXJlLi4uaWYgaXQgZXhwaXJlcyB3ZSB3aWxsIGhhdmUgdG8gcmVsb2cgaW5cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiB1c2VyVG9rZW59KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gdXNlclRva2VuKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgc2V0TG9naW5Vc2VyKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyh0cnVlKTtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Nvbm5lY3RlZCcsIHNlc3Npb25Vc2VyKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Mb2dPdXQoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0b2tlbiBpcyBubyBsb25nZXIgYXZhaWxhYmxlLlxuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9nb3V0VXJsIHx8IGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25VbmF1dGhvcml6ZWQobXNnKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygndW5hdXRob3JpemVkOiAnICsgSlNPTi5zdHJpbmdpZnkobXNnLmRhdGEpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRDb25uZWN0aW9uU3RhdHVzKGNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIHNlc3Npb25Vc2VyLmNvbm5lY3RlZCA9IGNvbm5lY3RlZDtcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmRlYnVnKFwiQ29ubmVjdGlvbiBzdGF0dXM6XCIgKyBKU09OLnN0cmluZ2lmeShzZXNzaW9uVXNlcikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRMb2dpblVzZXIodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8uYXNzaWduKHNlc3Npb25Vc2VyLCBwYXlsb2FkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gY2xlYXJUb2tlblRpbWVvdXQoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRva2VuVmFsaWRpdHlUaW1lb3V0KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbCh0b2tlblZhbGlkaXR5VGltZW91dCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZWNvZGUodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0VXJsID0gdG9rZW4uc3BsaXQoJy4nKVsxXTtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0ID0gYmFzZTY0VXJsLnJlcGxhY2UoJy0nLCAnKycpLnJlcGxhY2UoJ18nLCAnLycpO1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gSlNPTi5wYXJzZSgkd2luZG93LmF0b2IoYmFzZTY0KSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBheWxvYWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlcXVlc3ROZXdUb2tlbkJlZm9yZUV4cGlyYXRpb24odG9rZW4pIHtcbiAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGEgbGl0dGxlIGJlZm9yZS4uLlxuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuLCB7Y29tcGxldGU6IGZhbHNlfSk7XG5cbiAgICAgICAgICAgICAgICB2YXIgaW5pdGlhbCA9IHBheWxvYWQuZHVyO1xuXG4gICAgICAgICAgICAgICAgdmFyIGR1cmF0aW9uID0gKGluaXRpYWwgKiA5MCAvIDEwMCkgfCAwO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTY2hlZHVsZSB0byByZXF1ZXN0IGEgbmV3IHRva2VuIGluICcgKyBkdXJhdGlvbiArICcgc2Vjb25kcyAodG9rZW4gZHVyYXRpb246JyArIGluaXRpYWwgKyAnKScpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0b2tlblZhbGlkaXR5VGltZW91dCA9ICR0aW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7dG9rZW46IHRva2VufSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vdGU6IElmIGNvbW11bmljYXRpb24gY3Jhc2hlcyByaWdodCBhZnRlciB3ZSBlbWl0dGVkIGFuZCB3aGVuIHNlcnZlcnMgaXMgc2VuZGluZyBiYWNrIHRoZSB0b2tlbixcbiAgICAgICAgICAgICAgICAgICAgLy8gd2hlbiB0aGUgY2xpZW50IHJlZXN0YWJsaXNoZXMgdGhlIGNvbm5lY3Rpb24sIHdlIHdvdWxkIGhhdmUgdG8gbG9naW4gYmVjYXVzZSB0aGUgcHJldmlvdXMgdG9rZW4gd291bGQgYmUgaW52YWxpZGF0ZWQuXG4gICAgICAgICAgICAgICAgfSwgZHVyYXRpb24gKiAxMDAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJldHJpZXZlVG9rZW4oKSB7XG4gICAgICAgICAgICB2YXIgdXNlclRva2VuID0gJGxvY2F0aW9uLnNlYXJjaCgpLnRva2VuO1xuICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdVc2luZyB0b2tlbiBwYXNzZWQgZHVyaW5nIHJlZGlyZWN0aW9uOiAnICsgdXNlclRva2VuKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVzZXJUb2tlbiA9IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBpZiAodXNlclRva2VuKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgVG9rZW4gaW4gbG9jYWwgc3RvcmFnZTogJyArIHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOIHx8IHtzZXJpYWxpemU6IG5vb3AsIGRlc2VyaWFsaXplOiBub29wfTtcbiAgICBmdW5jdGlvbiBub29wKHYpIHtcbiAgICAgICAgcmV0dXJuIHY7XG4gICAgfVxuXG4gICAgdGhpcy5zZXREZWJ1ZyA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHNvY2tldGlvU2VydmljZSgkcm9vdFNjb3BlLCAkcSwgJGF1dGgpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9uOiBvbixcbiAgICAgICAgICAgIGVtaXQ6IGVtaXQsXG4gICAgICAgICAgICBsb2dvdXQ6ICRhdXRoLmxvZ291dCxcbiAgICAgICAgICAgIGZldGNoOiBmZXRjaCxcbiAgICAgICAgICAgIHBvc3Q6IHBvc3QsXG4gICAgICAgICAgICBub3RpZnk6IG5vdGlmeSxcbiAgICAgICAgfTtcblxuICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudE5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbihzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQub24oZXZlbnROYW1lLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBkZXByZWNhdGVkLCB1c2UgcG9zdC9ub3RpZnlcbiAgICAgICAgZnVuY3Rpb24gZW1pdChldmVudE5hbWUsIGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbihzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdChldmVudE5hbWUsIGRhdGEsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZldGNoIGRhdGEgdGhlIHdheSB3ZSBjYWxsIGFuIGFwaSBcbiAgICAgICAgICogaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8yMDY4NTIwOC93ZWJzb2NrZXQtdHJhbnNwb3J0LXJlbGlhYmlsaXR5LXNvY2tldC1pby1kYXRhLWxvc3MtZHVyaW5nLXJlY29ubmVjdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGZldGNoKG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnRmV0Y2hpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogbm90aWZ5IGlzIHNpbWlsYXIgdG8gZmV0Y2ggYnV0IG1vcmUgbWVhbmluZ2Z1bFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gbm90aWZ5KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnTm90aWZ5aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHBvc3Qgc2VuZHMgZGF0YSB0byB0aGUgc2VydmVyLlxuICAgICAgICAgKiBpZiBkYXRhIHdhcyBhbHJlYWR5IHN1Ym1pdHRlZCwgaXQgd291bGQganVzdCByZXR1cm4gLSB3aGljaCBjb3VsZCBoYXBwZW4gd2hlbiBoYW5kbGluZyBkaXNjb25uZWN0aW9uLlxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHBvc3Qob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdQb3N0aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIHZhciBzZXJpYWxpemVkID0gdHJhbnNwb3J0LnNlcmlhbGl6ZShkYXRhKTtcblxuICAgICAgICAgICAgcmV0dXJuICRhdXRoLmNvbm5lY3QoKVxuICAgICAgICAgICAgICAgIC50aGVuKG9uQ29ubmVjdGlvblN1Y2Nlc3MsIG9uQ29ubmVjdGlvbkVycm9yKVxuICAgICAgICAgICAgICAgIDsvLyAuY2F0Y2gob25Db25uZWN0aW9uRXJyb3IpO1xuXG4gICAgICAgICAgICAvLyAvLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25TdWNjZXNzKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2FwaScsIG9wZXJhdGlvbiwgc2VyaWFsaXplZCwgZnVuY3Rpb24oc2VyaWFsaXplZFJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgcmVzdWx0ID0gdHJhbnNwb3J0LmRlc2VyaWFsaXplKHNlcmlhbGl6ZWRSZXN1bHQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVidWcgJiYgY29uc29sZS5kZWJ1ZygnRXJyb3Igb24gJyArIG9wZXJhdGlvbiArICcgLT4nICsgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3Qoe2NvZGU6IHJlc3VsdC5jb2RlLCBkZXNjcmlwdGlvbjogcmVzdWx0LmRhdGF9KTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUocmVzdWx0LmRhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdGlvbkVycm9yKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiAkcS5yZWplY3Qoe2NvZGU6ICdDT05ORUNUSU9OX0VSUicsIGRlc2NyaXB0aW9uOiBlcnJ9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG59XG59KCkpO1xuXG4iLCJhbmd1bGFyLm1vZHVsZSgnemVydi5jb3JlJywgW10pO1xuIiwiXG4vKiogXG4gKiBUaGlzIHByb3ZpZGVyIGhhbmRsZXMgdGhlIGhhbmRzaGFrZSB0byBhdXRoZW50aWNhdGUgYSB1c2VyIGFuZCBtYWludGFpbiBhIHNlY3VyZSB3ZWIgc29ja2V0IGNvbm5lY3Rpb24gdmlhIHRva2Vucy5cbiAqIEl0IGFsc28gc2V0cyB0aGUgbG9naW4gYW5kIGxvZ291dCB1cmwgcGFydGljaXBhdGluZyBpbiB0aGUgYXV0aGVudGljYXRpb24uXG4gKiBcbiAqIFxuICogdXNhZ2UgZXhhbXBsZXM6XG4gKiBcbiAqIEluIHRoZSBjb25maWcgb2YgdGhlIGFwcCBtb2R1bGU6XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9naW5VcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9nb3V0VXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MoMTUpO1xuICogVGhpcyBkZWZpbmVzIGhvdyBtdWNoIHRpbWUgd2UgY2FuIHdhaXQgdG8gZXN0YWJsaXNoIGEgc3VjY2Vzc3VsIGNvbm5lY3Rpb24gYmVmb3JlIHJlamVjdGluZyB0aGUgY29ubmVjdGlvbiAoc29ja2V0U2VydmljZS5jb25uZWN0SU8pIHdpdGggYSB0aW1lb3V0LiBieSBkZWZhdWx0LCBpdCB3aWxsIHRyeSBmb3IgMTUgc2Vjb25kcyB0byBnZXQgYSBjb25uZWN0aW9uIGFuZCB0aGVuIGdpdmUgdXBcbiAqICBcbiAqIEJlZm9yZSBhbnkgc29ja2V0IHVzZSBpbiB5b3VyIHNlcnZpY2VzIG9yIHJlc29sdmUgYmxvY2tzLCBjb25uZWN0KCkgbWFrZXMgc3VyZSB0aGF0IHdlIGhhdmUgYW4gZXN0YWJsaXNoZWQgYXV0aGVudGljYXRlZCBjb25uZWN0aW9uIGJ5IHVzaW5nIHRoZSBmb2xsb3dpbmc6XG4gKiBzb2NrZXRTZXJ2aWNlLmNvbm5lY3QoKS50aGVuKFxuICogZnVuY3Rpb24oc29ja2V0KXsgLi4uIHNvY2tldC5lbWl0KCkuLiB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHsuLi59KVxuICogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLy8gY29udmVuaWVudCBzZXJ2aWNlIHJldHVybmluZyBzZXNzaW9uVXNlclxuICAgIC5mYWN0b3J5KCdzZXNzaW9uVXNlcicsIGZ1bmN0aW9uKCRhdXRoKSB7XG4gICAgICAgIHJldHVybiAkYXV0aC5nZXRTZXNzaW9uVXNlcigpO1xuICAgIH0pXG4gICAgLnByb3ZpZGVyKCckYXV0aCcsIGF1dGhQcm92aWRlcik7XG5cbmZ1bmN0aW9uIGF1dGhQcm92aWRlcigpIHtcbiAgICB2YXIgbG9naW5VcmwsIGxvZ291dFVybCwgZGVidWcsIHJlY29ubmVjdGlvbk1heFRpbWUgPSAxNTtcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ2luVXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9naW5VcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dvdXRVcmwgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBsb2dvdXRVcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgcmVjb25uZWN0aW9uTWF4VGltZSA9IHZhbHVlICogMTAwMDtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24oJHJvb3RTY29wZSwgJGxvY2F0aW9uLCAkdGltZW91dCwgJHEsICR3aW5kb3cpIHtcbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgdmFyIHVzZXJUb2tlbiA9IHJldHJpZXZlVG9rZW4oKTtcbiAgICAgICAgdmFyIHNlc3Npb25Vc2VyID0ge2Nvbm5lY3RlZDogZmFsc2V9O1xuXG4gICAgICAgIGlmICghdXNlclRva2VuKSB7XG4gICAgICAgICAgICAvLyBAVE9ETzogdGhpcyByaWdodCB3YXkgdG8gcmVkaXJlY3QgaWYgd2UgaGF2ZSBubyB0b2tlbiB3aGVuIHdlIHJlZnJlc2ggb3IgaGl0IHRoZSBhcHAuXG4gICAgICAgICAgICAvLyAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IHdvdWxkIHByZXZlbnQgbW9zdCB1bml0IHRlc3RzIGZyb20gcnVubmluZyBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIHRpZ2hseSBjb3VwbGVkIHdpdGggYWxsIHVuaXQgdGVzdHMgKGRlcGVuZHMgb24gaXQpYXQgdGhpcyB0aW1lIDpcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gdXNlclRva2VuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0OiBjb25uZWN0LFxuICAgICAgICAgICAgbG9nb3V0OiBsb2dvdXQsXG4gICAgICAgICAgICBnZXRTZXNzaW9uVXNlcjogZ2V0U2Vzc2lvblVzZXIsXG4gICAgICAgIH07XG5cblxuICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGdldFNlc3Npb25Vc2VyKCkge1xuICAgICAgICAgICAgLy8gdGhlIG9iamVjdCB3aWxsIGhhdmUgdGhlIHVzZXIgaW5mb3JtYXRpb24gd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZC4gT3RoZXJ3aXNlIGl0cyBjb25uZWN0aW9uIHByb3BlcnR5IHdpbGwgYmUgZmFsc2U7IFxuICAgICAgICAgICAgcmV0dXJuIHNlc3Npb25Vc2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIFxuICAgICAgICAgKiB0aGUgc3VjY2VzcyBmdW5jdGlvbiByZWNlaXZlcyB0aGUgc29ja2V0IGFzIGEgcGFyYW1ldGVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBjb25uZWN0KCkge1xuICAgICAgICAgICAgaWYgKCFzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzZXR1cCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGdldEZvclZhbGlkQ29ubmVjdGlvbigpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbG9nb3V0KCkge1xuICAgICAgICAgICAgLy8gY29ubmVjdGlvbiBjb3VsZCBiZSBsb3N0IGR1cmluZyBsb2dvdXQuLnNvIGl0IGNvdWxkIG1lYW4gd2UgaGF2ZSBub3QgbG9nb3V0IG9uIHNlcnZlciBzaWRlLlxuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdsb2dvdXQnLCB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Rm9yVmFsaWRDb25uZWN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGJlaW5nIHRoZSBzY2VuZSwgc29ja2V0LmlvIGlzIHRyeWluZyB0byByZWNvbm5lY3QgYW5kIGF1dGhlbnRpY2F0ZSBpZiB0aGUgY29ubmVjdGlvbiB3YXMgbG9zdDtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVVNFUl9OT1RfQ09OTkVDVEVEJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlY29ubmVjdCgpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBAVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgdmFyIG9mZiA9ICRyb290U2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGlmIChhY2NlcHRhYmxlRGVsYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKGFjY2VwdGFibGVEZWxheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhY2NlcHRhYmxlRGVsYXkgPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH0sIHJlY29ubmVjdGlvbk1heFRpbWUpO1xuXG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwKCkge1xuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIC8vIGFscmVhZHkgY2FsbGVkLi4uXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIHRva2VuVmFsaWRpdHlUaW1lb3V0O1xuICAgICAgICAgICAgLy8gZXN0YWJsaXNoIGNvbm5lY3Rpb24gd2l0aG91dCBwYXNzaW5nIHRoZSB0b2tlbiAoc28gdGhhdCBpdCBpcyBub3QgdmlzaWJsZSBpbiB0aGUgbG9nKVxuICAgICAgICAgICAgc29ja2V0ID0gaW8uY29ubmVjdCh7XG4gICAgICAgICAgICAgICAgJ2ZvcmNlTmV3JzogdHJ1ZSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3QnLCBvbkNvbm5lY3QpXG4gICAgICAgICAgICAgICAgLm9uKCdhdXRoZW50aWNhdGVkJywgb25BdXRoZW50aWNhdGVkKVxuICAgICAgICAgICAgICAgIC5vbigndW5hdXRob3JpemVkJywgb25VbmF1dGhvcml6ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCdsb2dnZWRfb3V0Jywgb25Mb2dPdXQpXG4gICAgICAgICAgICAgICAgLm9uKCdkaXNjb25uZWN0Jywgb25EaXNjb25uZWN0KTtcblxuICAgICAgICAgICAgLy8gVE9ETzogdGhpcyBmb2xsb3dvd2luZyBldmVudCBpcyBzdGlsbCB1c2VkLj8/Py4uLi5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdF9lcnJvcicsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0KCkge1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzb2NrZXQgaXMgY29ubmVjdGVkLCB0aW1lIHRvIHBhc3MgdGhlIHRva2VuIHRvIGF1dGhlbnRpY2F0ZSBhc2FwXG4gICAgICAgICAgICAgICAgLy8gYmVjYXVzZSB0aGUgdG9rZW4gaXMgYWJvdXQgdG8gZXhwaXJlLi4uaWYgaXQgZXhwaXJlcyB3ZSB3aWxsIGhhdmUgdG8gcmVsb2cgaW5cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiB1c2VyVG9rZW59KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gdXNlclRva2VuKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgc2V0TG9naW5Vc2VyKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyh0cnVlKTtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Nvbm5lY3RlZCcsIHNlc3Npb25Vc2VyKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Mb2dPdXQoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0b2tlbiBpcyBubyBsb25nZXIgYXZhaWxhYmxlLlxuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9nb3V0VXJsIHx8IGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25VbmF1dGhvcml6ZWQobXNnKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygndW5hdXRob3JpemVkOiAnICsgSlNPTi5zdHJpbmdpZnkobXNnLmRhdGEpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRDb25uZWN0aW9uU3RhdHVzKGNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIHNlc3Npb25Vc2VyLmNvbm5lY3RlZCA9IGNvbm5lY3RlZDtcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmRlYnVnKFwiQ29ubmVjdGlvbiBzdGF0dXM6XCIgKyBKU09OLnN0cmluZ2lmeShzZXNzaW9uVXNlcikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRMb2dpblVzZXIodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8uYXNzaWduKHNlc3Npb25Vc2VyLCBwYXlsb2FkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gY2xlYXJUb2tlblRpbWVvdXQoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRva2VuVmFsaWRpdHlUaW1lb3V0KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbCh0b2tlblZhbGlkaXR5VGltZW91dCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZWNvZGUodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0VXJsID0gdG9rZW4uc3BsaXQoJy4nKVsxXTtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0ID0gYmFzZTY0VXJsLnJlcGxhY2UoJy0nLCAnKycpLnJlcGxhY2UoJ18nLCAnLycpO1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gSlNPTi5wYXJzZSgkd2luZG93LmF0b2IoYmFzZTY0KSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBheWxvYWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlcXVlc3ROZXdUb2tlbkJlZm9yZUV4cGlyYXRpb24odG9rZW4pIHtcbiAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGEgbGl0dGxlIGJlZm9yZS4uLlxuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuLCB7Y29tcGxldGU6IGZhbHNlfSk7XG5cbiAgICAgICAgICAgICAgICB2YXIgaW5pdGlhbCA9IHBheWxvYWQuZHVyO1xuXG4gICAgICAgICAgICAgICAgdmFyIGR1cmF0aW9uID0gKGluaXRpYWwgKiA5MCAvIDEwMCkgfCAwO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTY2hlZHVsZSB0byByZXF1ZXN0IGEgbmV3IHRva2VuIGluICcgKyBkdXJhdGlvbiArICcgc2Vjb25kcyAodG9rZW4gZHVyYXRpb246JyArIGluaXRpYWwgKyAnKScpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0b2tlblZhbGlkaXR5VGltZW91dCA9ICR0aW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7dG9rZW46IHRva2VufSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vdGU6IElmIGNvbW11bmljYXRpb24gY3Jhc2hlcyByaWdodCBhZnRlciB3ZSBlbWl0dGVkIGFuZCB3aGVuIHNlcnZlcnMgaXMgc2VuZGluZyBiYWNrIHRoZSB0b2tlbixcbiAgICAgICAgICAgICAgICAgICAgLy8gd2hlbiB0aGUgY2xpZW50IHJlZXN0YWJsaXNoZXMgdGhlIGNvbm5lY3Rpb24sIHdlIHdvdWxkIGhhdmUgdG8gbG9naW4gYmVjYXVzZSB0aGUgcHJldmlvdXMgdG9rZW4gd291bGQgYmUgaW52YWxpZGF0ZWQuXG4gICAgICAgICAgICAgICAgfSwgZHVyYXRpb24gKiAxMDAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJldHJpZXZlVG9rZW4oKSB7XG4gICAgICAgICAgICB2YXIgdXNlclRva2VuID0gJGxvY2F0aW9uLnNlYXJjaCgpLnRva2VuO1xuICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdVc2luZyB0b2tlbiBwYXNzZWQgZHVyaW5nIHJlZGlyZWN0aW9uOiAnICsgdXNlclRva2VuKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVzZXJUb2tlbiA9IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBpZiAodXNlclRva2VuKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgVG9rZW4gaW4gbG9jYWwgc3RvcmFnZTogJyArIHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cblxuIiwiXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOIHx8IHtzZXJpYWxpemU6IG5vb3AsIGRlc2VyaWFsaXplOiBub29wfTtcbiAgICBmdW5jdGlvbiBub29wKHYpIHtcbiAgICAgICAgcmV0dXJuIHY7XG4gICAgfVxuXG4gICAgdGhpcy5zZXREZWJ1ZyA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHNvY2tldGlvU2VydmljZSgkcm9vdFNjb3BlLCAkcSwgJGF1dGgpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9uOiBvbixcbiAgICAgICAgICAgIGVtaXQ6IGVtaXQsXG4gICAgICAgICAgICBsb2dvdXQ6ICRhdXRoLmxvZ291dCxcbiAgICAgICAgICAgIGZldGNoOiBmZXRjaCxcbiAgICAgICAgICAgIHBvc3Q6IHBvc3QsXG4gICAgICAgICAgICBub3RpZnk6IG5vdGlmeSxcbiAgICAgICAgfTtcblxuICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudE5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbihzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQub24oZXZlbnROYW1lLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBkZXByZWNhdGVkLCB1c2UgcG9zdC9ub3RpZnlcbiAgICAgICAgZnVuY3Rpb24gZW1pdChldmVudE5hbWUsIGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbihzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdChldmVudE5hbWUsIGRhdGEsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZldGNoIGRhdGEgdGhlIHdheSB3ZSBjYWxsIGFuIGFwaSBcbiAgICAgICAgICogaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8yMDY4NTIwOC93ZWJzb2NrZXQtdHJhbnNwb3J0LXJlbGlhYmlsaXR5LXNvY2tldC1pby1kYXRhLWxvc3MtZHVyaW5nLXJlY29ubmVjdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGZldGNoKG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnRmV0Y2hpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogbm90aWZ5IGlzIHNpbWlsYXIgdG8gZmV0Y2ggYnV0IG1vcmUgbWVhbmluZ2Z1bFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gbm90aWZ5KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnTm90aWZ5aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHBvc3Qgc2VuZHMgZGF0YSB0byB0aGUgc2VydmVyLlxuICAgICAgICAgKiBpZiBkYXRhIHdhcyBhbHJlYWR5IHN1Ym1pdHRlZCwgaXQgd291bGQganVzdCByZXR1cm4gLSB3aGljaCBjb3VsZCBoYXBwZW4gd2hlbiBoYW5kbGluZyBkaXNjb25uZWN0aW9uLlxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHBvc3Qob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdQb3N0aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIHZhciBzZXJpYWxpemVkID0gdHJhbnNwb3J0LnNlcmlhbGl6ZShkYXRhKTtcblxuICAgICAgICAgICAgcmV0dXJuICRhdXRoLmNvbm5lY3QoKVxuICAgICAgICAgICAgICAgIC50aGVuKG9uQ29ubmVjdGlvblN1Y2Nlc3MsIG9uQ29ubmVjdGlvbkVycm9yKVxuICAgICAgICAgICAgICAgIDsvLyAuY2F0Y2gob25Db25uZWN0aW9uRXJyb3IpO1xuXG4gICAgICAgICAgICAvLyAvLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25TdWNjZXNzKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2FwaScsIG9wZXJhdGlvbiwgc2VyaWFsaXplZCwgZnVuY3Rpb24oc2VyaWFsaXplZFJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgcmVzdWx0ID0gdHJhbnNwb3J0LmRlc2VyaWFsaXplKHNlcmlhbGl6ZWRSZXN1bHQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVidWcgJiYgY29uc29sZS5kZWJ1ZygnRXJyb3Igb24gJyArIG9wZXJhdGlvbiArICcgLT4nICsgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3Qoe2NvZGU6IHJlc3VsdC5jb2RlLCBkZXNjcmlwdGlvbjogcmVzdWx0LmRhdGF9KTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUocmVzdWx0LmRhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdGlvbkVycm9yKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiAkcS5yZWplY3Qoe2NvZGU6ICdDT05ORUNUSU9OX0VSUicsIGRlc2NyaXB0aW9uOiBlcnJ9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG59XG5cbiJdfQ==

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
    var transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : {serialize: noop, deserialize: noop};
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInplcnYtbmctY29yZS5qcyIsInNvY2tldC5tb2R1bGUuanMiLCJzZXJ2aWNlcy9hdXRoLnNlcnZpY2UuanMiLCJzZXJ2aWNlcy9zb2NrZXRpby5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBLFFBQUEsT0FBQSxhQUFBOzs7QURNQSxDQUFDLFdBQVc7QUFDWjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FFYUE7S0FDQSxPQUFBOztLQUVBLFFBQUEseUJBQUEsU0FBQSxPQUFBO1FBQ0EsT0FBQSxNQUFBOztLQUVBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7SUFDQSxJQUFBLFVBQUEsV0FBQSxPQUFBLHNCQUFBOztJQUVBLEtBQUEsV0FBQSxTQUFBLE9BQUE7UUFDQSxRQUFBOzs7SUFHQSxLQUFBLGNBQUEsU0FBQSxPQUFBO1FBQ0EsV0FBQTs7O0lBR0EsS0FBQSxlQUFBLFNBQUEsT0FBQTtRQUNBLFlBQUE7OztJQUdBLEtBQUEsK0JBQUEsU0FBQSxPQUFBO1FBQ0Esc0JBQUEsUUFBQTs7O0lBR0EsS0FBQSxnRUFBQSxTQUFBLFlBQUEsV0FBQSxVQUFBLElBQUEsU0FBQTtRQUNBLElBQUE7UUFDQSxJQUFBLFlBQUE7UUFDQSxJQUFBLGNBQUEsQ0FBQSxXQUFBOztRQUVBLElBQUEsQ0FBQSxXQUFBOzs7OztlQUtBO1lBQ0EsYUFBQSxRQUFBOztRQUVBLE9BQUE7WUFDQSxTQUFBO1lBQ0EsUUFBQTtZQUNBLGdCQUFBOzs7Ozs7UUFNQSxTQUFBLGlCQUFBOztZQUVBLE9BQUE7Ozs7Ozs7UUFPQSxTQUFBLFVBQUE7WUFDQSxJQUFBLENBQUEsUUFBQTtnQkFDQTs7WUFFQSxPQUFBOzs7UUFHQSxTQUFBLFNBQUE7O1lBRUEsSUFBQSxRQUFBO2dCQUNBLE9BQUEsS0FBQSxVQUFBOzs7O1FBSUEsU0FBQSx3QkFBQTtZQUNBLElBQUEsV0FBQSxHQUFBO1lBQ0EsSUFBQSxZQUFBLFdBQUE7Z0JBQ0EsU0FBQSxR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QSxPQUFBLFdBQUEsV0FBQTs7Ozs7Ozs7UUFRQSxTQUFBLEtBQUEsV0FBQSxNQUFBO1lBQ0EsSUFBQSxPQUFBO2dCQUNBLFFBQUEsTUFBQSxhQUFBLFlBQUE7O1lBRUEsT0FBQSxXQUFBLFdBQUE7OztRQUdBLFNBQUEsV0FBQSxXQUFBLE1BQUE7WUFDQSxJQUFBLGFBQUEsVUFBQSxVQUFBOztZQUVBLE9BQUEsTUFBQTtpQkFDQSxLQUFBLHFCQUFBOzs7O1lBSUEsU0FBQSxvQkFBQSxRQUFBO2dCQUNBLElBQUEsV0FBQSxHQUFBO2dCQUNBLE9BQUEsS0FBQSxPQUFBLFdBQUEsWUFBQSxTQUFBLGtCQUFBO29CQUNBLElBQUEsU0FBQSxVQUFBLFlBQUE7O29CQUVBLElBQUEsT0FBQSxNQUFBO3dCQUNBLFNBQUEsUUFBQSxNQUFBLGNBQUEsWUFBQSxRQUFBLEtBQUEsVUFBQTt3QkFDQSxTQUFBLE9BQUEsQ0FBQSxNQUFBLE9BQUEsTUFBQSxhQUFBLE9BQUE7MkJBQ0E7d0JBQ0EsU0FBQSxRQUFBLE9BQUE7OztnQkFHQSxPQUFBLFNBQUE7OztZQUdBLFNBQUEsa0JBQUEsS0FBQTtnQkFDQSxPQUFBLEdBQUEsT0FBQSxDQUFBLE1BQUEsa0JBQUEsYUFBQTs7Ozs7OztBSHFTQSIsImZpbGUiOiJ6ZXJ2LW5nLWNvcmUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhci5tb2R1bGUoJ3plcnYuY29yZScsIFtdKTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHByb3ZpZGVyIGhhbmRsZXMgdGhlIGhhbmRzaGFrZSB0byBhdXRoZW50aWNhdGUgYSB1c2VyIGFuZCBtYWludGFpbiBhIHNlY3VyZSB3ZWIgc29ja2V0IGNvbm5lY3Rpb24gdmlhIHRva2Vucy5cbiAqIEl0IGFsc28gc2V0cyB0aGUgbG9naW4gYW5kIGxvZ291dCB1cmwgcGFydGljaXBhdGluZyBpbiB0aGUgYXV0aGVudGljYXRpb24uXG4gKiBcbiAqIFxuICogdXNhZ2UgZXhhbXBsZXM6XG4gKiBcbiAqIEluIHRoZSBjb25maWcgb2YgdGhlIGFwcCBtb2R1bGU6XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9naW5VcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9nb3V0VXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MoMTUpO1xuICogVGhpcyBkZWZpbmVzIGhvdyBtdWNoIHRpbWUgd2UgY2FuIHdhaXQgdG8gZXN0YWJsaXNoIGEgc3VjY2Vzc3VsIGNvbm5lY3Rpb24gYmVmb3JlIHJlamVjdGluZyB0aGUgY29ubmVjdGlvbiAoc29ja2V0U2VydmljZS5jb25uZWN0SU8pIHdpdGggYSB0aW1lb3V0LiBieSBkZWZhdWx0LCBpdCB3aWxsIHRyeSBmb3IgMTUgc2Vjb25kcyB0byBnZXQgYSBjb25uZWN0aW9uIGFuZCB0aGVuIGdpdmUgdXBcbiAqICBcbiAqIEJlZm9yZSBhbnkgc29ja2V0IHVzZSBpbiB5b3VyIHNlcnZpY2VzIG9yIHJlc29sdmUgYmxvY2tzLCBjb25uZWN0KCkgbWFrZXMgc3VyZSB0aGF0IHdlIGhhdmUgYW4gZXN0YWJsaXNoZWQgYXV0aGVudGljYXRlZCBjb25uZWN0aW9uIGJ5IHVzaW5nIHRoZSBmb2xsb3dpbmc6XG4gKiBzb2NrZXRTZXJ2aWNlLmNvbm5lY3QoKS50aGVuKFxuICogZnVuY3Rpb24oc29ja2V0KXsgLi4uIHNvY2tldC5lbWl0KCkuLiB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHsuLi59KVxuICogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLy8gY29udmVuaWVudCBzZXJ2aWNlIHJldHVybmluZyBzZXNzaW9uVXNlclxuICAgIC5mYWN0b3J5KCdzZXNzaW9uVXNlcicsIGZ1bmN0aW9uKCRhdXRoKSB7XG4gICAgICAgIHJldHVybiAkYXV0aC5nZXRTZXNzaW9uVXNlcigpO1xuICAgIH0pXG4gICAgLnByb3ZpZGVyKCckYXV0aCcsIGF1dGhQcm92aWRlcik7XG5cbmZ1bmN0aW9uIGF1dGhQcm92aWRlcigpIHtcbiAgICB2YXIgbG9naW5VcmwsIGxvZ291dFVybCwgZGVidWcsIHJlY29ubmVjdGlvbk1heFRpbWUgPSAxNTtcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ2luVXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9naW5VcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dvdXRVcmwgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBsb2dvdXRVcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgcmVjb25uZWN0aW9uTWF4VGltZSA9IHZhbHVlICogMTAwMDtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24oJHJvb3RTY29wZSwgJGxvY2F0aW9uLCAkdGltZW91dCwgJHEsICR3aW5kb3cpIHtcbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgdmFyIHVzZXJUb2tlbiA9IHJldHJpZXZlVG9rZW4oKTtcbiAgICAgICAgdmFyIHNlc3Npb25Vc2VyID0ge2Nvbm5lY3RlZDogZmFsc2V9O1xuXG4gICAgICAgIGlmICghdXNlclRva2VuKSB7XG4gICAgICAgICAgICAvLyBAVE9ETzogdGhpcyByaWdodCB3YXkgdG8gcmVkaXJlY3QgaWYgd2UgaGF2ZSBubyB0b2tlbiB3aGVuIHdlIHJlZnJlc2ggb3IgaGl0IHRoZSBhcHAuXG4gICAgICAgICAgICAvLyAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IHdvdWxkIHByZXZlbnQgbW9zdCB1bml0IHRlc3RzIGZyb20gcnVubmluZyBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIHRpZ2hseSBjb3VwbGVkIHdpdGggYWxsIHVuaXQgdGVzdHMgKGRlcGVuZHMgb24gaXQpYXQgdGhpcyB0aW1lIDpcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gdXNlclRva2VuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0OiBjb25uZWN0LFxuICAgICAgICAgICAgbG9nb3V0OiBsb2dvdXQsXG4gICAgICAgICAgICBnZXRTZXNzaW9uVXNlcjogZ2V0U2Vzc2lvblVzZXIsXG4gICAgICAgIH07XG5cblxuICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGdldFNlc3Npb25Vc2VyKCkge1xuICAgICAgICAgICAgLy8gdGhlIG9iamVjdCB3aWxsIGhhdmUgdGhlIHVzZXIgaW5mb3JtYXRpb24gd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZC4gT3RoZXJ3aXNlIGl0cyBjb25uZWN0aW9uIHByb3BlcnR5IHdpbGwgYmUgZmFsc2U7IFxuICAgICAgICAgICAgcmV0dXJuIHNlc3Npb25Vc2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIFxuICAgICAgICAgKiB0aGUgc3VjY2VzcyBmdW5jdGlvbiByZWNlaXZlcyB0aGUgc29ja2V0IGFzIGEgcGFyYW1ldGVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBjb25uZWN0KCkge1xuICAgICAgICAgICAgaWYgKCFzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzZXR1cCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGdldEZvclZhbGlkQ29ubmVjdGlvbigpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbG9nb3V0KCkge1xuICAgICAgICAgICAgLy8gY29ubmVjdGlvbiBjb3VsZCBiZSBsb3N0IGR1cmluZyBsb2dvdXQuLnNvIGl0IGNvdWxkIG1lYW4gd2UgaGF2ZSBub3QgbG9nb3V0IG9uIHNlcnZlciBzaWRlLlxuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdsb2dvdXQnLCB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Rm9yVmFsaWRDb25uZWN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGJlaW5nIHRoZSBzY2VuZSwgc29ja2V0LmlvIGlzIHRyeWluZyB0byByZWNvbm5lY3QgYW5kIGF1dGhlbnRpY2F0ZSBpZiB0aGUgY29ubmVjdGlvbiB3YXMgbG9zdDtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVVNFUl9OT1RfQ09OTkVDVEVEJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlY29ubmVjdCgpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBAVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgdmFyIG9mZiA9ICRyb290U2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGlmIChhY2NlcHRhYmxlRGVsYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKGFjY2VwdGFibGVEZWxheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhY2NlcHRhYmxlRGVsYXkgPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH0sIHJlY29ubmVjdGlvbk1heFRpbWUpO1xuXG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwKCkge1xuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIC8vIGFscmVhZHkgY2FsbGVkLi4uXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIHRva2VuVmFsaWRpdHlUaW1lb3V0O1xuICAgICAgICAgICAgLy8gZXN0YWJsaXNoIGNvbm5lY3Rpb24gd2l0aG91dCBwYXNzaW5nIHRoZSB0b2tlbiAoc28gdGhhdCBpdCBpcyBub3QgdmlzaWJsZSBpbiB0aGUgbG9nKVxuICAgICAgICAgICAgc29ja2V0ID0gaW8uY29ubmVjdCh7XG4gICAgICAgICAgICAgICAgJ2ZvcmNlTmV3JzogdHJ1ZSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3QnLCBvbkNvbm5lY3QpXG4gICAgICAgICAgICAgICAgLm9uKCdhdXRoZW50aWNhdGVkJywgb25BdXRoZW50aWNhdGVkKVxuICAgICAgICAgICAgICAgIC5vbigndW5hdXRob3JpemVkJywgb25VbmF1dGhvcml6ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCdsb2dnZWRfb3V0Jywgb25Mb2dPdXQpXG4gICAgICAgICAgICAgICAgLm9uKCdkaXNjb25uZWN0Jywgb25EaXNjb25uZWN0KTtcblxuICAgICAgICAgICAgLy8gVE9ETzogdGhpcyBmb2xsb3dvd2luZyBldmVudCBpcyBzdGlsbCB1c2VkLj8/Py4uLi5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdF9lcnJvcicsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0KCkge1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzb2NrZXQgaXMgY29ubmVjdGVkLCB0aW1lIHRvIHBhc3MgdGhlIHRva2VuIHRvIGF1dGhlbnRpY2F0ZSBhc2FwXG4gICAgICAgICAgICAgICAgLy8gYmVjYXVzZSB0aGUgdG9rZW4gaXMgYWJvdXQgdG8gZXhwaXJlLi4uaWYgaXQgZXhwaXJlcyB3ZSB3aWxsIGhhdmUgdG8gcmVsb2cgaW5cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiB1c2VyVG9rZW59KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gdXNlclRva2VuKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgc2V0TG9naW5Vc2VyKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyh0cnVlKTtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Nvbm5lY3RlZCcsIHNlc3Npb25Vc2VyKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Mb2dPdXQoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0b2tlbiBpcyBubyBsb25nZXIgYXZhaWxhYmxlLlxuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9nb3V0VXJsIHx8IGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25VbmF1dGhvcml6ZWQobXNnKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygndW5hdXRob3JpemVkOiAnICsgSlNPTi5zdHJpbmdpZnkobXNnLmRhdGEpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRDb25uZWN0aW9uU3RhdHVzKGNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIHNlc3Npb25Vc2VyLmNvbm5lY3RlZCA9IGNvbm5lY3RlZDtcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmRlYnVnKFwiQ29ubmVjdGlvbiBzdGF0dXM6XCIgKyBKU09OLnN0cmluZ2lmeShzZXNzaW9uVXNlcikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRMb2dpblVzZXIodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8uYXNzaWduKHNlc3Npb25Vc2VyLCBwYXlsb2FkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gY2xlYXJUb2tlblRpbWVvdXQoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRva2VuVmFsaWRpdHlUaW1lb3V0KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbCh0b2tlblZhbGlkaXR5VGltZW91dCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZWNvZGUodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0VXJsID0gdG9rZW4uc3BsaXQoJy4nKVsxXTtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0ID0gYmFzZTY0VXJsLnJlcGxhY2UoJy0nLCAnKycpLnJlcGxhY2UoJ18nLCAnLycpO1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gSlNPTi5wYXJzZSgkd2luZG93LmF0b2IoYmFzZTY0KSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBheWxvYWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlcXVlc3ROZXdUb2tlbkJlZm9yZUV4cGlyYXRpb24odG9rZW4pIHtcbiAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGEgbGl0dGxlIGJlZm9yZS4uLlxuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuLCB7Y29tcGxldGU6IGZhbHNlfSk7XG5cbiAgICAgICAgICAgICAgICB2YXIgaW5pdGlhbCA9IHBheWxvYWQuZHVyO1xuXG4gICAgICAgICAgICAgICAgdmFyIGR1cmF0aW9uID0gKGluaXRpYWwgKiA5MCAvIDEwMCkgfCAwO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTY2hlZHVsZSB0byByZXF1ZXN0IGEgbmV3IHRva2VuIGluICcgKyBkdXJhdGlvbiArICcgc2Vjb25kcyAodG9rZW4gZHVyYXRpb246JyArIGluaXRpYWwgKyAnKScpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0b2tlblZhbGlkaXR5VGltZW91dCA9ICR0aW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7dG9rZW46IHRva2VufSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vdGU6IElmIGNvbW11bmljYXRpb24gY3Jhc2hlcyByaWdodCBhZnRlciB3ZSBlbWl0dGVkIGFuZCB3aGVuIHNlcnZlcnMgaXMgc2VuZGluZyBiYWNrIHRoZSB0b2tlbixcbiAgICAgICAgICAgICAgICAgICAgLy8gd2hlbiB0aGUgY2xpZW50IHJlZXN0YWJsaXNoZXMgdGhlIGNvbm5lY3Rpb24sIHdlIHdvdWxkIGhhdmUgdG8gbG9naW4gYmVjYXVzZSB0aGUgcHJldmlvdXMgdG9rZW4gd291bGQgYmUgaW52YWxpZGF0ZWQuXG4gICAgICAgICAgICAgICAgfSwgZHVyYXRpb24gKiAxMDAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJldHJpZXZlVG9rZW4oKSB7XG4gICAgICAgICAgICB2YXIgdXNlclRva2VuID0gJGxvY2F0aW9uLnNlYXJjaCgpLnRva2VuO1xuICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdVc2luZyB0b2tlbiBwYXNzZWQgZHVyaW5nIHJlZGlyZWN0aW9uOiAnICsgdXNlclRva2VuKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVzZXJUb2tlbiA9IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBpZiAodXNlclRva2VuKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgVG9rZW4gaW4gbG9jYWwgc3RvcmFnZTogJyArIHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOICYmICF3aW5kb3cuWkpTT05CSU4uZGlzYWJsZWQgPyB3aW5kb3cuWkpTT05CSU4gOiB7c2VyaWFsaXplOiBub29wLCBkZXNlcmlhbGl6ZTogbm9vcH07XG4gICAgZnVuY3Rpb24gbm9vcCh2KSB7XG4gICAgICAgIHJldHVybiB2O1xuICAgIH1cblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiBzb2NrZXRpb1NlcnZpY2UoJHJvb3RTY29wZSwgJHEsICRhdXRoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvbjogb24sXG4gICAgICAgICAgICBlbWl0OiBlbWl0LFxuICAgICAgICAgICAgbG9nb3V0OiAkYXV0aC5sb2dvdXQsXG4gICAgICAgICAgICBmZXRjaDogZmV0Y2gsXG4gICAgICAgICAgICBwb3N0OiBwb3N0LFxuICAgICAgICAgICAgbm90aWZ5OiBub3RpZnksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgZnVuY3Rpb24gb24oZXZlbnROYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0Lm9uKGV2ZW50TmFtZSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVwcmVjYXRlZCwgdXNlIHBvc3Qvbm90aWZ5XG4gICAgICAgIGZ1bmN0aW9uIGVtaXQoZXZlbnROYW1lLCBkYXRhLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoZXZlbnROYW1lLCBkYXRhLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmZXRjaCBkYXRhIHRoZSB3YXkgd2UgY2FsbCBhbiBhcGkgXG4gICAgICAgICAqIGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMjA2ODUyMDgvd2Vic29ja2V0LXRyYW5zcG9ydC1yZWxpYWJpbGl0eS1zb2NrZXQtaW8tZGF0YS1sb3NzLWR1cmluZy1yZWNvbm5lY3Rpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBmZXRjaChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ0ZldGNoaW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIG5vdGlmeSBpcyBzaW1pbGFyIHRvIGZldGNoIGJ1dCBtb3JlIG1lYW5pbmdmdWxcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ05vdGlmeWluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBwb3N0IHNlbmRzIGRhdGEgdG8gdGhlIHNlcnZlci5cbiAgICAgICAgICogaWYgZGF0YSB3YXMgYWxyZWFkeSBzdWJtaXR0ZWQsIGl0IHdvdWxkIGp1c3QgcmV0dXJuIC0gd2hpY2ggY291bGQgaGFwcGVuIHdoZW4gaGFuZGxpbmcgZGlzY29ubmVjdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBwb3N0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnUG9zdGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICB2YXIgc2VyaWFsaXplZCA9IHRyYW5zcG9ydC5zZXJpYWxpemUoZGF0YSk7XG5cbiAgICAgICAgICAgIHJldHVybiAkYXV0aC5jb25uZWN0KClcbiAgICAgICAgICAgICAgICAudGhlbihvbkNvbm5lY3Rpb25TdWNjZXNzLCBvbkNvbm5lY3Rpb25FcnJvcilcbiAgICAgICAgICAgICAgICA7Ly8gLmNhdGNoKG9uQ29ubmVjdGlvbkVycm9yKTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uU3VjY2Vzcyhzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhcGknLCBvcGVyYXRpb24sIHNlcmlhbGl6ZWQsIGZ1bmN0aW9uKHNlcmlhbGl6ZWRSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHRyYW5zcG9ydC5kZXNlcmlhbGl6ZShzZXJpYWxpemVkUmVzdWx0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAocmVzdWx0LmNvZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlYnVnICYmIGNvbnNvbGUuZGVidWcoJ0Vycm9yIG9uICcgKyBvcGVyYXRpb24gKyAnIC0+JyArIEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KHtjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHJlc3VsdC5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25FcnJvcihlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJHEucmVqZWN0KHtjb2RlOiAnQ09OTkVDVElPTl9FUlInLCBkZXNjcmlwdGlvbjogZXJyfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xufVxufSgpKTtcblxuIiwiYW5ndWxhci5tb2R1bGUoJ3plcnYuY29yZScsIFtdKTtcbiIsIlxuLyoqIFxuICogVGhpcyBwcm92aWRlciBoYW5kbGVzIHRoZSBoYW5kc2hha2UgdG8gYXV0aGVudGljYXRlIGEgdXNlciBhbmQgbWFpbnRhaW4gYSBzZWN1cmUgd2ViIHNvY2tldCBjb25uZWN0aW9uIHZpYSB0b2tlbnMuXG4gKiBJdCBhbHNvIHNldHMgdGhlIGxvZ2luIGFuZCBsb2dvdXQgdXJsIHBhcnRpY2lwYXRpbmcgaW4gdGhlIGF1dGhlbnRpY2F0aW9uLlxuICogXG4gKiBcbiAqIHVzYWdlIGV4YW1wbGVzOlxuICogXG4gKiBJbiB0aGUgY29uZmlnIG9mIHRoZSBhcHAgbW9kdWxlOlxuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ2luVXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ291dFVybCgnL2FjY2VzcyMvbG9naW4nKTtcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzKDE1KTtcbiAqIFRoaXMgZGVmaW5lcyBob3cgbXVjaCB0aW1lIHdlIGNhbiB3YWl0IHRvIGVzdGFibGlzaCBhIHN1Y2Nlc3N1bCBjb25uZWN0aW9uIGJlZm9yZSByZWplY3RpbmcgdGhlIGNvbm5lY3Rpb24gKHNvY2tldFNlcnZpY2UuY29ubmVjdElPKSB3aXRoIGEgdGltZW91dC4gYnkgZGVmYXVsdCwgaXQgd2lsbCB0cnkgZm9yIDE1IHNlY29uZHMgdG8gZ2V0IGEgY29ubmVjdGlvbiBhbmQgdGhlbiBnaXZlIHVwXG4gKiAgXG4gKiBCZWZvcmUgYW55IHNvY2tldCB1c2UgaW4geW91ciBzZXJ2aWNlcyBvciByZXNvbHZlIGJsb2NrcywgY29ubmVjdCgpIG1ha2VzIHN1cmUgdGhhdCB3ZSBoYXZlIGFuIGVzdGFibGlzaGVkIGF1dGhlbnRpY2F0ZWQgY29ubmVjdGlvbiBieSB1c2luZyB0aGUgZm9sbG93aW5nOlxuICogc29ja2V0U2VydmljZS5jb25uZWN0KCkudGhlbihcbiAqIGZ1bmN0aW9uKHNvY2tldCl7IC4uLiBzb2NrZXQuZW1pdCgpLi4gfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7Li4ufSlcbiAqIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCd6ZXJ2LmNvcmUnKVxuICAgIC8vIGNvbnZlbmllbnQgc2VydmljZSByZXR1cm5pbmcgc2Vzc2lvblVzZXJcbiAgICAuZmFjdG9yeSgnc2Vzc2lvblVzZXInLCBmdW5jdGlvbigkYXV0aCkge1xuICAgICAgICByZXR1cm4gJGF1dGguZ2V0U2Vzc2lvblVzZXIoKTtcbiAgICB9KVxuICAgIC5wcm92aWRlcignJGF1dGgnLCBhdXRoUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBhdXRoUHJvdmlkZXIoKSB7XG4gICAgdmFyIGxvZ2luVXJsLCBsb2dvdXRVcmwsIGRlYnVnLCByZWNvbm5lY3Rpb25NYXhUaW1lID0gMTU7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dpblVybCA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGxvZ2luVXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0TG9nb3V0VXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9nb3V0VXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0UmVjb25uZWN0aW9uTWF4VGltZUluU2VjcyA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIHJlY29ubmVjdGlvbk1heFRpbWUgPSB2YWx1ZSAqIDEwMDA7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uKCRyb290U2NvcGUsICRsb2NhdGlvbiwgJHRpbWVvdXQsICRxLCAkd2luZG93KSB7XG4gICAgICAgIHZhciBzb2NrZXQ7XG4gICAgICAgIHZhciB1c2VyVG9rZW4gPSByZXRyaWV2ZVRva2VuKCk7XG4gICAgICAgIHZhciBzZXNzaW9uVXNlciA9IHtjb25uZWN0ZWQ6IGZhbHNlfTtcblxuICAgICAgICBpZiAoIXVzZXJUb2tlbikge1xuICAgICAgICAgICAgLy8gQFRPRE86IHRoaXMgcmlnaHQgd2F5IHRvIHJlZGlyZWN0IGlmIHdlIGhhdmUgbm8gdG9rZW4gd2hlbiB3ZSByZWZyZXNoIG9yIGhpdCB0aGUgYXBwLlxuICAgICAgICAgICAgLy8gIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIC8vIGJ1dCBpdCB3b3VsZCBwcmV2ZW50IG1vc3QgdW5pdCB0ZXN0cyBmcm9tIHJ1bm5pbmcgYmVjYXVzZSB0aGlzIG1vZHVsZSBpcyB0aWdobHkgY291cGxlZCB3aXRoIGFsbCB1bml0IHRlc3RzIChkZXBlbmRzIG9uIGl0KWF0IHRoaXMgdGltZSA6XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHVzZXJUb2tlbjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29ubmVjdDogY29ubmVjdCxcbiAgICAgICAgICAgIGxvZ291dDogbG9nb3V0LFxuICAgICAgICAgICAgZ2V0U2Vzc2lvblVzZXI6IGdldFNlc3Npb25Vc2VyLFxuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZXNzaW9uVXNlcigpIHtcbiAgICAgICAgICAgIC8vIHRoZSBvYmplY3Qgd2lsbCBoYXZlIHRoZSB1c2VyIGluZm9ybWF0aW9uIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuIE90aGVyd2lzZSBpdHMgY29ubmVjdGlvbiBwcm9wZXJ0eSB3aWxsIGJlIGZhbHNlOyBcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uVXNlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSBcbiAgICAgICAgICogdGhlIHN1Y2Nlc3MgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHNvY2tldCBhcyBhIHBhcmFtZXRlclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY29ubmVjdCgpIHtcbiAgICAgICAgICAgIGlmICghc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0dXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxvZ291dCgpIHtcbiAgICAgICAgICAgIC8vIGNvbm5lY3Rpb24gY291bGQgYmUgbG9zdCBkdXJpbmcgbG9nb3V0Li5zbyBpdCBjb3VsZCBtZWFuIHdlIGhhdmUgbm90IGxvZ291dCBvbiBzZXJ2ZXIgc2lkZS5cbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnbG9nb3V0JywgdXNlclRva2VuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldEZvclZhbGlkQ29ubmVjdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBiZWluZyB0aGUgc2NlbmUsIHNvY2tldC5pbyBpcyB0cnlpbmcgdG8gcmVjb25uZWN0IGFuZCBhdXRoZW50aWNhdGUgaWYgdGhlIGNvbm5lY3Rpb24gd2FzIGxvc3Q7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0KCkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1VTRVJfTk9UX0NPTk5FQ1RFRCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWNvbm5lY3QoKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuXG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQFRPRE8gVE8gVEhJTksgQUJPVVQ6LCBpZiB0aGUgc29ja2V0IGlzIGNvbm5lY3RpbmcgYWxyZWFkeSwgbWVhbnMgdGhhdCBhIGNvbm5lY3Qgd2FzIGNhbGxlZCBhbHJlYWR5IGJ5IGFub3RoZXIgYXN5bmMgY2FsbCwgc28ganVzdCB3YWl0IGZvciB1c2VyX2Nvbm5lY3RlZFxuXG5cbiAgICAgICAgICAgIC8vIGlmIHRoZSByZXNwb25zZSBkb2VzIG5vdCBjb21lIHF1aWNrLi5sZXQncyBnaXZlIHVwIHNvIHdlIGRvbid0IGdldCBzdHVjayB3YWl0aW5nXG4gICAgICAgICAgICAvLyBAVE9ETzpvdGhlciB3YXkgaXMgdG8gd2F0Y2ggZm9yIGEgY29ubmVjdGlvbiBlcnJvci4uLlxuICAgICAgICAgICAgdmFyIGFjY2VwdGFibGVEZWxheTtcbiAgICAgICAgICAgIHZhciBvZmYgPSAkcm9vdFNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoYWNjZXB0YWJsZURlbGF5KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbChhY2NlcHRhYmxlRGVsYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYWNjZXB0YWJsZURlbGF5ID0gJHRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdUSU1FT1VUJyk7XG4gICAgICAgICAgICB9LCByZWNvbm5lY3Rpb25NYXhUaW1lKTtcblxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cCgpIHtcbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICAvLyBhbHJlYWR5IGNhbGxlZC4uLlxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciB0b2tlblZhbGlkaXR5VGltZW91dDtcbiAgICAgICAgICAgIC8vIGVzdGFibGlzaCBjb25uZWN0aW9uIHdpdGhvdXQgcGFzc2luZyB0aGUgdG9rZW4gKHNvIHRoYXQgaXQgaXMgbm90IHZpc2libGUgaW4gdGhlIGxvZylcbiAgICAgICAgICAgIHNvY2tldCA9IGlvLmNvbm5lY3Qoe1xuICAgICAgICAgICAgICAgICdmb3JjZU5ldyc6IHRydWUsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0Jywgb25Db25uZWN0KVxuICAgICAgICAgICAgICAgIC5vbignYXV0aGVudGljYXRlZCcsIG9uQXV0aGVudGljYXRlZClcbiAgICAgICAgICAgICAgICAub24oJ3VuYXV0aG9yaXplZCcsIG9uVW5hdXRob3JpemVkKVxuICAgICAgICAgICAgICAgIC5vbignbG9nZ2VkX291dCcsIG9uTG9nT3V0KVxuICAgICAgICAgICAgICAgIC5vbignZGlzY29ubmVjdCcsIG9uRGlzY29ubmVjdCk7XG5cbiAgICAgICAgICAgIC8vIFRPRE86IHRoaXMgZm9sbG93b3dpbmcgZXZlbnQgaXMgc3RpbGwgdXNlZC4/Pz8uLi4uXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3RfZXJyb3InLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc29ja2V0IGlzIGNvbm5lY3RlZCwgdGltZSB0byBwYXNzIHRoZSB0b2tlbiB0byBhdXRoZW50aWNhdGUgYXNhcFxuICAgICAgICAgICAgICAgIC8vIGJlY2F1c2UgdGhlIHRva2VuIGlzIGFib3V0IHRvIGV4cGlyZS4uLmlmIGl0IGV4cGlyZXMgd2Ugd2lsbCBoYXZlIHRvIHJlbG9nIGluXG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2F1dGhlbnRpY2F0ZScsIHt0b2tlbjogdXNlclRva2VufSk7IC8vIHNlbmQgdGhlIGp3dFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkRpc2Nvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1Nlc3Npb24gZGlzY29ubmVjdGVkJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9kaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25BdXRoZW50aWNhdGVkKHJlZnJlc2hUb2tlbikge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNlcnZlciBjb25maXJtZWQgdGhhdCB0aGUgdG9rZW4gaXMgdmFsaWQuLi53ZSBhcmUgZ29vZCB0byBnb1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdhdXRoZW50aWNhdGVkLCByZWNlaXZlZCBuZXcgdG9rZW46ICcgKyAocmVmcmVzaFRva2VuICE9IHVzZXJUb2tlbikpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2UudG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgdXNlclRva2VuID0gcmVmcmVzaFRva2VuO1xuICAgICAgICAgICAgICAgIHNldExvZ2luVXNlcih1c2VyVG9rZW4pO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXModHJ1ZSk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbih1c2VyVG9rZW4pO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9jb25uZWN0ZWQnLCBzZXNzaW9uVXNlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uTG9nT3V0KCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdG9rZW4gaXMgbm8gbG9uZ2VyIGF2YWlsYWJsZS5cbiAgICAgICAgICAgICAgICBkZWxldGUgbG9jYWxTdG9yYWdlLnRva2VuO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ291dFVybCB8fCBsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVW5hdXRob3JpemVkKG1zZykge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ3VuYXV0aG9yaXplZDogJyArIEpTT04uc3RyaW5naWZ5KG1zZy5kYXRhKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Q29ubmVjdGlvblN0YXR1cyhjb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBzZXNzaW9uVXNlci5jb25uZWN0ZWQgPSBjb25uZWN0ZWQ7XG4gICAgICAgICAgICAgICAgLy8gY29uc29sZS5kZWJ1ZyhcIkNvbm5lY3Rpb24gc3RhdHVzOlwiICsgSlNPTi5zdHJpbmdpZnkoc2Vzc2lvblVzZXIpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2V0TG9naW5Vc2VyKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBkZWNvZGUodG9rZW4pO1xuICAgICAgICAgICAgICAgIHJldHVybiBfLmFzc2lnbihzZXNzaW9uVXNlciwgcGF5bG9hZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNsZWFyVG9rZW5UaW1lb3V0KCkge1xuICAgICAgICAgICAgICAgIGlmICh0b2tlblZhbGlkaXR5VGltZW91dCkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwodG9rZW5WYWxpZGl0eVRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVjb2RlKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NFVybCA9IHRva2VuLnNwbGl0KCcuJylbMV07XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NCA9IGJhc2U2NFVybC5yZXBsYWNlKCctJywgJysnKS5yZXBsYWNlKCdfJywgJy8nKTtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IEpTT04ucGFyc2UoJHdpbmRvdy5hdG9iKGJhc2U2NCkpO1xuICAgICAgICAgICAgICAgIHJldHVybiBwYXlsb2FkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgLy8gcmVxdWVzdCBhIGxpdHRsZSBiZWZvcmUuLi5cbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbiwge2NvbXBsZXRlOiBmYWxzZX0pO1xuXG4gICAgICAgICAgICAgICAgdmFyIGluaXRpYWwgPSBwYXlsb2FkLmR1cjtcblxuICAgICAgICAgICAgICAgIHZhciBkdXJhdGlvbiA9IChpbml0aWFsICogOTAgLyAxMDApIHwgMDtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2NoZWR1bGUgdG8gcmVxdWVzdCBhIG5ldyB0b2tlbiBpbiAnICsgZHVyYXRpb24gKyAnIHNlY29uZHMgKHRva2VuIGR1cmF0aW9uOicgKyBpbml0aWFsICsgJyknKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdG9rZW5WYWxpZGl0eVRpbWVvdXQgPSAkdGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdUaW1lIHRvIHJlcXVlc3QgbmV3IHRva2VuICcgKyBpbml0aWFsKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiB0b2tlbn0pO1xuICAgICAgICAgICAgICAgICAgICAvLyBOb3RlOiBJZiBjb21tdW5pY2F0aW9uIGNyYXNoZXMgcmlnaHQgYWZ0ZXIgd2UgZW1pdHRlZCBhbmQgd2hlbiBzZXJ2ZXJzIGlzIHNlbmRpbmcgYmFjayB0aGUgdG9rZW4sXG4gICAgICAgICAgICAgICAgICAgIC8vIHdoZW4gdGhlIGNsaWVudCByZWVzdGFibGlzaGVzIHRoZSBjb25uZWN0aW9uLCB3ZSB3b3VsZCBoYXZlIHRvIGxvZ2luIGJlY2F1c2UgdGhlIHByZXZpb3VzIHRva2VuIHdvdWxkIGJlIGludmFsaWRhdGVkLlxuICAgICAgICAgICAgICAgIH0sIGR1cmF0aW9uICogMTAwMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZXRyaWV2ZVRva2VuKCkge1xuICAgICAgICAgICAgdmFyIHVzZXJUb2tlbiA9ICRsb2NhdGlvbi5zZWFyY2goKS50b2tlbjtcbiAgICAgICAgICAgIGlmICh1c2VyVG9rZW4pIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgdG9rZW4gcGFzc2VkIGR1cmluZyByZWRpcmVjdGlvbjogJyArIHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1VzaW5nIFRva2VuIGluIGxvY2FsIHN0b3JhZ2U6ICcgKyB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB1c2VyVG9rZW47XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWRpcmVjdCh1cmwpIHtcbiAgICAgICAgICAgIHdpbmRvdy5sb2NhdGlvbi5yZXBsYWNlKHVybCB8fCAnYmFkVXJsLmh0bWwnKTtcbiAgICAgICAgfVxuICAgIH07XG59XG5cbiIsIlxuLyoqIFxuICogVGhpcyBzZXJ2aWNlIGFsbG93cyB5b3VyIGFwcGxpY2F0aW9uIGNvbnRhY3QgdGhlIHdlYnNvY2tldCBhcGkuXG4gKiBcbiAqIEl0IHdpbGwgZW5zdXJlIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgYXZhaWxhYmxlIGFuZCB1c2VyIGlzIGF1dGhlbnRpY2F0ZWQgYmVmb3JlIGZldGNoaW5nIGRhdGEuXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLnByb3ZpZGVyKCckc29ja2V0aW8nLCBzb2NrZXRpb1Byb3ZpZGVyKTtcblxuZnVuY3Rpb24gc29ja2V0aW9Qcm92aWRlcigpIHtcbiAgICB2YXIgZGVidWc7XG4gICAgdmFyIHRyYW5zcG9ydCA9IHdpbmRvdy5aSlNPTkJJTiAmJiAhd2luZG93LlpKU09OQklOLmRpc2FibGVkID8gd2luZG93LlpKU09OQklOIDoge3NlcmlhbGl6ZTogbm9vcCwgZGVzZXJpYWxpemU6IG5vb3B9O1xuICAgIGZ1bmN0aW9uIG5vb3Aodikge1xuICAgICAgICByZXR1cm4gdjtcbiAgICB9XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc29ja2V0aW9TZXJ2aWNlKCRyb290U2NvcGUsICRxLCAkYXV0aCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb246IG9uLFxuICAgICAgICAgICAgZW1pdDogZW1pdCxcbiAgICAgICAgICAgIGxvZ291dDogJGF1dGgubG9nb3V0LFxuICAgICAgICAgICAgZmV0Y2g6IGZldGNoLFxuICAgICAgICAgICAgcG9zdDogcG9zdCxcbiAgICAgICAgICAgIG5vdGlmeTogbm90aWZ5LFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIC8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50TmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICRhdXRoLmNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5vbihldmVudE5hbWUsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIC8vIGRlcHJlY2F0ZWQsIHVzZSBwb3N0L25vdGlmeVxuICAgICAgICBmdW5jdGlvbiBlbWl0KGV2ZW50TmFtZSwgZGF0YSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICRhdXRoLmNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KGV2ZW50TmFtZSwgZGF0YSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogZmV0Y2ggZGF0YSB0aGUgd2F5IHdlIGNhbGwgYW4gYXBpIFxuICAgICAgICAgKiBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vcXVlc3Rpb25zLzIwNjg1MjA4L3dlYnNvY2tldC10cmFuc3BvcnQtcmVsaWFiaWxpdHktc29ja2V0LWlvLWRhdGEtbG9zcy1kdXJpbmctcmVjb25uZWN0aW9uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gZmV0Y2gob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdGZXRjaGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBub3RpZnkgaXMgc2ltaWxhciB0byBmZXRjaCBidXQgbW9yZSBtZWFuaW5nZnVsXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBub3RpZnkob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdOb3RpZnlpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogcG9zdCBzZW5kcyBkYXRhIHRvIHRoZSBzZXJ2ZXIuXG4gICAgICAgICAqIGlmIGRhdGEgd2FzIGFscmVhZHkgc3VibWl0dGVkLCBpdCB3b3VsZCBqdXN0IHJldHVybiAtIHdoaWNoIGNvdWxkIGhhcHBlbiB3aGVuIGhhbmRsaW5nIGRpc2Nvbm5lY3Rpb24uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcG9zdChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1Bvc3RpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgdmFyIHNlcmlhbGl6ZWQgPSB0cmFuc3BvcnQuc2VyaWFsaXplKGRhdGEpO1xuXG4gICAgICAgICAgICByZXR1cm4gJGF1dGguY29ubmVjdCgpXG4gICAgICAgICAgICAgICAgLnRoZW4ob25Db25uZWN0aW9uU3VjY2Vzcywgb25Db25uZWN0aW9uRXJyb3IpXG4gICAgICAgICAgICAgICAgOy8vIC5jYXRjaChvbkNvbm5lY3Rpb25FcnJvcik7XG5cbiAgICAgICAgICAgIC8vIC8vLy8vLy8vLy9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdGlvblN1Y2Nlc3Moc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXBpJywgb3BlcmF0aW9uLCBzZXJpYWxpemVkLCBmdW5jdGlvbihzZXJpYWxpemVkUmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciByZXN1bHQgPSB0cmFuc3BvcnQuZGVzZXJpYWxpemUoc2VyaWFsaXplZFJlc3VsdCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlc3VsdC5jb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWJ1ZyAmJiBjb25zb2xlLmRlYnVnKCdFcnJvciBvbiAnICsgb3BlcmF0aW9uICsgJyAtPicgKyBKU09OLnN0cmluZ2lmeShyZXN1bHQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCh7Y29kZTogcmVzdWx0LmNvZGUsIGRlc2NyaXB0aW9uOiByZXN1bHQuZGF0YX0pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHQuZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uRXJyb3IoZXJyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICRxLnJlamVjdCh7Y29kZTogJ0NPTk5FQ1RJT05fRVJSJywgZGVzY3JpcHRpb246IGVycn0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcbn1cblxuIl19

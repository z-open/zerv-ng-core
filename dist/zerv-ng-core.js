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

    this.$get = ["$rootScope", "$location", "$timeout", "$interval", "$q", "$window", function($rootScope, $location, $timeout, $interval, $q, $window) {
        var socket;
        localStorage.token = retrieveAuthCode() || localStorage.token;
        const sessionUser = {connected: false};

        if (!localStorage.token) {
            delete localStorage.origin;
            // @TODO: this right way to redirect if we have no token when we refresh or hit the app.
            //  redirect(loginUrl);
            // but it would prevent most unit tests from running because this module is tighly coupled with all unit tests (depends on it)at this time :
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
                socket.emit('logout', localStorage.token);
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
            const deferred = $q.defer();

            if (sessionUser.connected) {
                deferred.resolve(socket);
            }
            // @TODO TO THINK ABOUT:, if the socket is connecting already, means that a connect was called already by another async call, so just wait for user_connected


            // if the response does not come quick..let's give up so we don't get stuck waiting
            // @TODO:other way is to watch for a connection error...
            var acceptableDelay;
            const off = $rootScope.$on('user_connected', function() {
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
                // Pass the origin if any to handle multi session on a browser.
                setConnectionStatus(false);
                // the socket is connected, time to pass the auth code or current token to authenticate asap
                // because if it expires, user will have to relog in
                socket.emit('authenticate', {token: localStorage.token, origin: localStorage.origin}); // send the jwt
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
                    console.debug('authenticated, received new token: ' + (refreshToken != localStorage.token));
                }
                localStorage.token = refreshToken;

                // identify origin for multi session
                if (!localStorage.origin) {
                    localStorage.origin = refreshToken;
                }

                setLoginUser(refreshToken);
                setConnectionStatus(true);
                requestNewTokenBeforeExpiration(refreshToken);
                $rootScope.$broadcast('user_connected', sessionUser);
            }

            function onLogOut() {
                clearTokenTimeout();
                // token is no longer available.
                delete localStorage.token;
                delete localStorage.origin;
                setConnectionStatus(false);
                redirect(logoutUrl || loginUrl);
            }

            function onUnauthorized(msg) {
                clearTokenTimeout();
                if (debug) {
                    console.debug('unauthorized: ' + JSON.stringify(msg));
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
                if (tokenValidityTimeout) {
                    return;
                }
                // request a little before...
                var payload = decode(token, {complete: false});

                var initial = payload.dur;

                var duration = (initial * 90 / 100) | 0;
                if (debug) {
                    console.debug('Schedule to request a new token in ' + duration + ' seconds (token duration:' + initial + ')');
                }
                tokenValidityTimeout = $interval(function() {
                    if (debug) {
                        console.debug('Time to request new token ' + initial);
                    }
                    // re authenticate with the token from the storage since another browser could have modified it.
                    if (!localStorage.token) {
                        onUnauthorized('Token no longer available');
                    }
                    socket.emit('authenticate', {token: localStorage.token});
                    // Note: If communication crashes right after we emitted and when servers is sending back the token,
                    // when the client reestablishes the connection, we would have to login because the previous token would be invalidated.
                }, duration * 1000);
            }
        }

        function retrieveAuthCode() {
            var userToken = $location.search().token;
            if (userToken && debug) {
                console.debug('Using Auth Code passed during redirection: ' + userToken);
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInplcnYtbmctY29yZS5qcyIsInNvY2tldC5tb2R1bGUuanMiLCJzZXJ2aWNlcy9hdXRoLnNlcnZpY2UuanMiLCJzZXJ2aWNlcy9zb2NrZXRpby5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBLFFBQUEsT0FBQSxhQUFBOzs7QURNQSxDQUFDLFdBQVc7QUFDWjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FFYUE7S0FDQSxPQUFBOztLQUVBLFFBQUEseUJBQUEsU0FBQSxPQUFBO1FBQ0EsT0FBQSxNQUFBOztLQUVBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7SUFDQSxJQUFBLFVBQUEsV0FBQSxPQUFBLHNCQUFBOztJQUVBLEtBQUEsV0FBQSxTQUFBLE9BQUE7UUFDQSxRQUFBOzs7SUFHQSxLQUFBLGNBQUEsU0FBQSxPQUFBO1FBQ0EsV0FBQTs7O0lBR0EsS0FBQSxlQUFBLFNBQUEsT0FBQTtRQUNBLFlBQUE7OztJQUdBLEtBQUEsK0JBQUEsU0FBQSxPQUFBO1FBQ0Esc0JBQUEsUUFBQTs7O0lBR0EsS0FBQSw2RUFBQSxTQUFBLFlBQUEsV0FBQSxVQUFBLFdBQUEsSUFBQSxTQUFBO1FBQ0EsSUFBQTtRQUNBLGFBQUEsUUFBQSxzQkFBQSxhQUFBO1FBQ0EsTUFBQSxjQUFBLENBQUEsV0FBQTs7UUFFQSxJQUFBLENBQUEsYUFBQSxPQUFBO1lBQ0EsT0FBQSxhQUFBOzs7Ozs7UUFNQSxPQUFBO1lBQ0EsU0FBQTtZQUNBLFFBQUE7WUFDQSxnQkFBQTs7Ozs7O1FBTUEsU0FBQSxpQkFBQTs7WUFFQSxPQUFBOzs7Ozs7O1FBT0EsU0FBQSxVQUFBO1lBQ0EsSUFBQSxDQUFBLFFBQUE7Z0JBQ0E7O1lBRUEsT0FBQTs7O1FBR0EsU0FBQSxTQUFBOztZQUVBLElBQUEsUUFBQTtnQkFDQSxPQUFBLEtBQUEsVUFBQSxhQUFBOzs7O1FBSUEsU0FBQSx3QkFBQTtZQUNBLElBQUEsV0FBQSxHQUFBO1lBQ0EsSUFBQSxZ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QUFBLE9BQUEsV0FBQSxNQUFBO1lBQ0EsSUFBQSxPQUFBO2dCQUNBLFFBQUEsTUFBQSxlQUFBLFlBQUE7O1lBRUEsT0FBQSxXQUFBLFdBQUE7Ozs7Ozs7O1FBUUEsU0FBQSxLQUFBLFdBQUEsTUFBQTtZQUNBLElBQUEsT0FBQTtnQkFDQSxRQUFBLE1BQUEsYUFBQSxZQUFBOztZQUVBLE9BQUEsV0FBQSxXQUFBOzs7UUFHQSxTQUFBLFdBQUEsV0FBQSxNQUFBO1lBQ0EsSUFBQSxhQUFBLFVBQUEsVUFBQTs7WUFFQSxPQUFBLE1BQUE7aUJBQ0EsS0FBQSxxQkFBQTs7OztZQUlBLFNBQUEsb0JBQUEsUUFBQTtnQkFDQSxJQUFBLFdBQUEsR0FBQTtnQkFDQSxPQUFBLEtBQUEsT0FBQSxXQUFBLFlBQUEsU0FBQSxrQkFBQTtvQkFDQSxJQUFBLFNBQUEsVUFBQSxZQUFBOztvQkFFQSxJQUFBLE9BQUEsTUFBQTt3QkFDQSxTQUFBLFFBQUEsTUFBQSxjQUFBLFlBQUEsUUFBQSxLQUFBLFVBQUE7d0JBQ0EsU0FBQSxPQUFBLENBQUEsTUFBQSxPQUFBLE1BQUEsYUFBQSxPQUFBOzJCQUNBO3dCQUNBLFNBQUEsUUFBQSxPQUFBOzs7Z0JBR0EsT0FBQSxTQUFBOzs7WUFHQSxTQUFBLGtCQUFBLEtBQUE7Z0JBQ0EsT0FBQSxHQUFBLE9BQUEsQ0FBQSxNQUFBLGtCQUFBLGFBQUE7Ozs7Ozs7QUh1U0EiLCJmaWxlIjoiemVydi1uZy1jb3JlLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXIubW9kdWxlKCd6ZXJ2LmNvcmUnLCBbXSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuLyoqIFxuICogVGhpcyBwcm92aWRlciBoYW5kbGVzIHRoZSBoYW5kc2hha2UgdG8gYXV0aGVudGljYXRlIGEgdXNlciBhbmQgbWFpbnRhaW4gYSBzZWN1cmUgd2ViIHNvY2tldCBjb25uZWN0aW9uIHZpYSB0b2tlbnMuXG4gKiBJdCBhbHNvIHNldHMgdGhlIGxvZ2luIGFuZCBsb2dvdXQgdXJsIHBhcnRpY2lwYXRpbmcgaW4gdGhlIGF1dGhlbnRpY2F0aW9uLlxuICogXG4gKiBcbiAqIHVzYWdlIGV4YW1wbGVzOlxuICogXG4gKiBJbiB0aGUgY29uZmlnIG9mIHRoZSBhcHAgbW9kdWxlOlxuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ2luVXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ291dFVybCgnL2FjY2VzcyMvbG9naW4nKTtcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzKDE1KTtcbiAqIFRoaXMgZGVmaW5lcyBob3cgbXVjaCB0aW1lIHdlIGNhbiB3YWl0IHRvIGVzdGFibGlzaCBhIHN1Y2Nlc3N1bCBjb25uZWN0aW9uIGJlZm9yZSByZWplY3RpbmcgdGhlIGNvbm5lY3Rpb24gKHNvY2tldFNlcnZpY2UuY29ubmVjdElPKSB3aXRoIGEgdGltZW91dC4gYnkgZGVmYXVsdCwgaXQgd2lsbCB0cnkgZm9yIDE1IHNlY29uZHMgdG8gZ2V0IGEgY29ubmVjdGlvbiBhbmQgdGhlbiBnaXZlIHVwXG4gKiAgXG4gKiBCZWZvcmUgYW55IHNvY2tldCB1c2UgaW4geW91ciBzZXJ2aWNlcyBvciByZXNvbHZlIGJsb2NrcywgY29ubmVjdCgpIG1ha2VzIHN1cmUgdGhhdCB3ZSBoYXZlIGFuIGVzdGFibGlzaGVkIGF1dGhlbnRpY2F0ZWQgY29ubmVjdGlvbiBieSB1c2luZyB0aGUgZm9sbG93aW5nOlxuICogc29ja2V0U2VydmljZS5jb25uZWN0KCkudGhlbihcbiAqIGZ1bmN0aW9uKHNvY2tldCl7IC4uLiBzb2NrZXQuZW1pdCgpLi4gfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7Li4ufSlcbiAqIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCd6ZXJ2LmNvcmUnKVxuICAgIC8vIGNvbnZlbmllbnQgc2VydmljZSByZXR1cm5pbmcgc2Vzc2lvblVzZXJcbiAgICAuZmFjdG9yeSgnc2Vzc2lvblVzZXInLCBmdW5jdGlvbigkYXV0aCkge1xuICAgICAgICByZXR1cm4gJGF1dGguZ2V0U2Vzc2lvblVzZXIoKTtcbiAgICB9KVxuICAgIC5wcm92aWRlcignJGF1dGgnLCBhdXRoUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBhdXRoUHJvdmlkZXIoKSB7XG4gICAgdmFyIGxvZ2luVXJsLCBsb2dvdXRVcmwsIGRlYnVnLCByZWNvbm5lY3Rpb25NYXhUaW1lID0gMTU7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dpblVybCA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGxvZ2luVXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0TG9nb3V0VXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9nb3V0VXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0UmVjb25uZWN0aW9uTWF4VGltZUluU2VjcyA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIHJlY29ubmVjdGlvbk1heFRpbWUgPSB2YWx1ZSAqIDEwMDA7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uKCRyb290U2NvcGUsICRsb2NhdGlvbiwgJHRpbWVvdXQsICRpbnRlcnZhbCwgJHEsICR3aW5kb3cpIHtcbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gcmV0cmlldmVBdXRoQ29kZSgpIHx8IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgY29uc3Qgc2Vzc2lvblVzZXIgPSB7Y29ubmVjdGVkOiBmYWxzZX07XG5cbiAgICAgICAgaWYgKCFsb2NhbFN0b3JhZ2UudG9rZW4pIHtcbiAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2Uub3JpZ2luO1xuICAgICAgICAgICAgLy8gQFRPRE86IHRoaXMgcmlnaHQgd2F5IHRvIHJlZGlyZWN0IGlmIHdlIGhhdmUgbm8gdG9rZW4gd2hlbiB3ZSByZWZyZXNoIG9yIGhpdCB0aGUgYXBwLlxuICAgICAgICAgICAgLy8gIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIC8vIGJ1dCBpdCB3b3VsZCBwcmV2ZW50IG1vc3QgdW5pdCB0ZXN0cyBmcm9tIHJ1bm5pbmcgYmVjYXVzZSB0aGlzIG1vZHVsZSBpcyB0aWdobHkgY291cGxlZCB3aXRoIGFsbCB1bml0IHRlc3RzIChkZXBlbmRzIG9uIGl0KWF0IHRoaXMgdGltZSA6XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29ubmVjdDogY29ubmVjdCxcbiAgICAgICAgICAgIGxvZ291dDogbG9nb3V0LFxuICAgICAgICAgICAgZ2V0U2Vzc2lvblVzZXI6IGdldFNlc3Npb25Vc2VyLFxuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZXNzaW9uVXNlcigpIHtcbiAgICAgICAgICAgIC8vIHRoZSBvYmplY3Qgd2lsbCBoYXZlIHRoZSB1c2VyIGluZm9ybWF0aW9uIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuIE90aGVyd2lzZSBpdHMgY29ubmVjdGlvbiBwcm9wZXJ0eSB3aWxsIGJlIGZhbHNlOyBcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uVXNlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSBcbiAgICAgICAgICogdGhlIHN1Y2Nlc3MgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHNvY2tldCBhcyBhIHBhcmFtZXRlclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY29ubmVjdCgpIHtcbiAgICAgICAgICAgIGlmICghc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0dXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxvZ291dCgpIHtcbiAgICAgICAgICAgIC8vIGNvbm5lY3Rpb24gY291bGQgYmUgbG9zdCBkdXJpbmcgbG9nb3V0Li5zbyBpdCBjb3VsZCBtZWFuIHdlIGhhdmUgbm90IGxvZ291dCBvbiBzZXJ2ZXIgc2lkZS5cbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnbG9nb3V0JywgbG9jYWxTdG9yYWdlLnRva2VuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldEZvclZhbGlkQ29ubmVjdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBiZWluZyB0aGUgc2NlbmUsIHNvY2tldC5pbyBpcyB0cnlpbmcgdG8gcmVjb25uZWN0IGFuZCBhdXRoZW50aWNhdGUgaWYgdGhlIGNvbm5lY3Rpb24gd2FzIGxvc3Q7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0KCkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1VTRVJfTk9UX0NPTk5FQ1RFRCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWNvbm5lY3QoKSB7XG4gICAgICAgICAgICBjb25zdCBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBAVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgY29uc3Qgb2ZmID0gJHJvb3RTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKGFjY2VwdGFibGVEZWxheSkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwoYWNjZXB0YWJsZURlbGF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFjY2VwdGFibGVEZWxheSA9ICR0aW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVElNRU9VVCcpO1xuICAgICAgICAgICAgfSwgcmVjb25uZWN0aW9uTWF4VGltZSk7XG5cbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2V0dXAoKSB7XG4gICAgICAgICAgICBpZiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgLy8gYWxyZWFkeSBjYWxsZWQuLi5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgdG9rZW5WYWxpZGl0eVRpbWVvdXQ7XG4gICAgICAgICAgICAvLyBlc3RhYmxpc2ggY29ubmVjdGlvbiB3aXRob3V0IHBhc3NpbmcgdGhlIHRva2VuIChzbyB0aGF0IGl0IGlzIG5vdCB2aXNpYmxlIGluIHRoZSBsb2cpXG4gICAgICAgICAgICBzb2NrZXQgPSBpby5jb25uZWN0KHtcbiAgICAgICAgICAgICAgICAnZm9yY2VOZXcnOiB0cnVlLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdCcsIG9uQ29ubmVjdClcbiAgICAgICAgICAgICAgICAub24oJ2F1dGhlbnRpY2F0ZWQnLCBvbkF1dGhlbnRpY2F0ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCd1bmF1dGhvcml6ZWQnLCBvblVuYXV0aG9yaXplZClcbiAgICAgICAgICAgICAgICAub24oJ2xvZ2dlZF9vdXQnLCBvbkxvZ091dClcbiAgICAgICAgICAgICAgICAub24oJ2Rpc2Nvbm5lY3QnLCBvbkRpc2Nvbm5lY3QpO1xuXG4gICAgICAgICAgICAvLyBUT0RPOiB0aGlzIGZvbGxvd293aW5nIGV2ZW50IGlzIHN0aWxsIHVzZWQuPz8/Li4uLlxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0X2Vycm9yJywgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgLy8gUGFzcyB0aGUgb3JpZ2luIGlmIGFueSB0byBoYW5kbGUgbXVsdGkgc2Vzc2lvbiBvbiBhIGJyb3dzZXIuXG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNvY2tldCBpcyBjb25uZWN0ZWQsIHRpbWUgdG8gcGFzcyB0aGUgYXV0aCBjb2RlIG9yIGN1cnJlbnQgdG9rZW4gdG8gYXV0aGVudGljYXRlIGFzYXBcbiAgICAgICAgICAgICAgICAvLyBiZWNhdXNlIGlmIGl0IGV4cGlyZXMsIHVzZXIgd2lsbCBoYXZlIHRvIHJlbG9nIGluXG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2F1dGhlbnRpY2F0ZScsIHt0b2tlbjogbG9jYWxTdG9yYWdlLnRva2VuLCBvcmlnaW46IGxvY2FsU3RvcmFnZS5vcmlnaW59KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gbG9jYWxTdG9yYWdlLnRva2VuKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcblxuICAgICAgICAgICAgICAgIC8vIGlkZW50aWZ5IG9yaWdpbiBmb3IgbXVsdGkgc2Vzc2lvblxuICAgICAgICAgICAgICAgIGlmICghbG9jYWxTdG9yYWdlLm9yaWdpbikge1xuICAgICAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2Uub3JpZ2luID0gcmVmcmVzaFRva2VuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHNldExvZ2luVXNlcihyZWZyZXNoVG9rZW4pO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXModHJ1ZSk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbihyZWZyZXNoVG9rZW4pO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9jb25uZWN0ZWQnLCBzZXNzaW9uVXNlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uTG9nT3V0KCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdG9rZW4gaXMgbm8gbG9uZ2VyIGF2YWlsYWJsZS5cbiAgICAgICAgICAgICAgICBkZWxldGUgbG9jYWxTdG9yYWdlLnRva2VuO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2Uub3JpZ2luO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ291dFVybCB8fCBsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVW5hdXRob3JpemVkKG1zZykge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ3VuYXV0aG9yaXplZDogJyArIEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICByZWRpcmVjdChsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldENvbm5lY3Rpb25TdGF0dXMoY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgc2Vzc2lvblVzZXIuY29ubmVjdGVkID0gY29ubmVjdGVkO1xuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUuZGVidWcoXCJDb25uZWN0aW9uIHN0YXR1czpcIiArIEpTT04uc3RyaW5naWZ5KHNlc3Npb25Vc2VyKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldExvZ2luVXNlcih0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5hc3NpZ24oc2Vzc2lvblVzZXIsIHBheWxvYWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBjbGVhclRva2VuVGltZW91dCgpIHtcbiAgICAgICAgICAgICAgICBpZiAodG9rZW5WYWxpZGl0eVRpbWVvdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKHRva2VuVmFsaWRpdHlUaW1lb3V0KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlY29kZSh0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjRVcmwgPSB0b2tlbi5zcGxpdCgnLicpWzFdO1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjQgPSBiYXNlNjRVcmwucmVwbGFjZSgnLScsICcrJykucmVwbGFjZSgnXycsICcvJyk7XG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBKU09OLnBhcnNlKCR3aW5kb3cuYXRvYihiYXNlNjQpKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGF5bG9hZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbih0b2tlbikge1xuICAgICAgICAgICAgICAgIGlmICh0b2tlblZhbGlkaXR5VGltZW91dCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIHJlcXVlc3QgYSBsaXR0bGUgYmVmb3JlLi4uXG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBkZWNvZGUodG9rZW4sIHtjb21wbGV0ZTogZmFsc2V9KTtcblxuICAgICAgICAgICAgICAgIHZhciBpbml0aWFsID0gcGF5bG9hZC5kdXI7XG5cbiAgICAgICAgICAgICAgICB2YXIgZHVyYXRpb24gPSAoaW5pdGlhbCAqIDkwIC8gMTAwKSB8IDA7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NjaGVkdWxlIHRvIHJlcXVlc3QgYSBuZXcgdG9rZW4gaW4gJyArIGR1cmF0aW9uICsgJyBzZWNvbmRzICh0b2tlbiBkdXJhdGlvbjonICsgaW5pdGlhbCArICcpJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRva2VuVmFsaWRpdHlUaW1lb3V0ID0gJGludGVydmFsKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIHJlIGF1dGhlbnRpY2F0ZSB3aXRoIHRoZSB0b2tlbiBmcm9tIHRoZSBzdG9yYWdlIHNpbmNlIGFub3RoZXIgYnJvd3NlciBjb3VsZCBoYXZlIG1vZGlmaWVkIGl0LlxuICAgICAgICAgICAgICAgICAgICBpZiAoIWxvY2FsU3RvcmFnZS50b2tlbikge1xuICAgICAgICAgICAgICAgICAgICAgICAgb25VbmF1dGhvcml6ZWQoJ1Rva2VuIG5vIGxvbmdlciBhdmFpbGFibGUnKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiBsb2NhbFN0b3JhZ2UudG9rZW59KTtcbiAgICAgICAgICAgICAgICAgICAgLy8gTm90ZTogSWYgY29tbXVuaWNhdGlvbiBjcmFzaGVzIHJpZ2h0IGFmdGVyIHdlIGVtaXR0ZWQgYW5kIHdoZW4gc2VydmVycyBpcyBzZW5kaW5nIGJhY2sgdGhlIHRva2VuLFxuICAgICAgICAgICAgICAgICAgICAvLyB3aGVuIHRoZSBjbGllbnQgcmVlc3RhYmxpc2hlcyB0aGUgY29ubmVjdGlvbiwgd2Ugd291bGQgaGF2ZSB0byBsb2dpbiBiZWNhdXNlIHRoZSBwcmV2aW91cyB0b2tlbiB3b3VsZCBiZSBpbnZhbGlkYXRlZC5cbiAgICAgICAgICAgICAgICB9LCBkdXJhdGlvbiAqIDEwMDApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmV0cmlldmVBdXRoQ29kZSgpIHtcbiAgICAgICAgICAgIHZhciB1c2VyVG9rZW4gPSAkbG9jYXRpb24uc2VhcmNoKCkudG9rZW47XG4gICAgICAgICAgICBpZiAodXNlclRva2VuICYmIGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgQXV0aCBDb2RlIHBhc3NlZCBkdXJpbmcgcmVkaXJlY3Rpb246ICcgKyB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOICYmICF3aW5kb3cuWkpTT05CSU4uZGlzYWJsZWQgPyB3aW5kb3cuWkpTT05CSU4gOiB7c2VyaWFsaXplOiBub29wLCBkZXNlcmlhbGl6ZTogbm9vcH07XG4gICAgZnVuY3Rpb24gbm9vcCh2KSB7XG4gICAgICAgIHJldHVybiB2O1xuICAgIH1cblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiBzb2NrZXRpb1NlcnZpY2UoJHJvb3RTY29wZSwgJHEsICRhdXRoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvbjogb24sXG4gICAgICAgICAgICBlbWl0OiBlbWl0LFxuICAgICAgICAgICAgbG9nb3V0OiAkYXV0aC5sb2dvdXQsXG4gICAgICAgICAgICBmZXRjaDogZmV0Y2gsXG4gICAgICAgICAgICBwb3N0OiBwb3N0LFxuICAgICAgICAgICAgbm90aWZ5OiBub3RpZnksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgZnVuY3Rpb24gb24oZXZlbnROYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0Lm9uKGV2ZW50TmFtZSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVwcmVjYXRlZCwgdXNlIHBvc3Qvbm90aWZ5XG4gICAgICAgIGZ1bmN0aW9uIGVtaXQoZXZlbnROYW1lLCBkYXRhLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoZXZlbnROYW1lLCBkYXRhLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmZXRjaCBkYXRhIHRoZSB3YXkgd2UgY2FsbCBhbiBhcGkgXG4gICAgICAgICAqIGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMjA2ODUyMDgvd2Vic29ja2V0LXRyYW5zcG9ydC1yZWxpYWJpbGl0eS1zb2NrZXQtaW8tZGF0YS1sb3NzLWR1cmluZy1yZWNvbm5lY3Rpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBmZXRjaChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ0ZldGNoaW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIG5vdGlmeSBpcyBzaW1pbGFyIHRvIGZldGNoIGJ1dCBtb3JlIG1lYW5pbmdmdWxcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ05vdGlmeWluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBwb3N0IHNlbmRzIGRhdGEgdG8gdGhlIHNlcnZlci5cbiAgICAgICAgICogaWYgZGF0YSB3YXMgYWxyZWFkeSBzdWJtaXR0ZWQsIGl0IHdvdWxkIGp1c3QgcmV0dXJuIC0gd2hpY2ggY291bGQgaGFwcGVuIHdoZW4gaGFuZGxpbmcgZGlzY29ubmVjdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBwb3N0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnUG9zdGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICB2YXIgc2VyaWFsaXplZCA9IHRyYW5zcG9ydC5zZXJpYWxpemUoZGF0YSk7XG5cbiAgICAgICAgICAgIHJldHVybiAkYXV0aC5jb25uZWN0KClcbiAgICAgICAgICAgICAgICAudGhlbihvbkNvbm5lY3Rpb25TdWNjZXNzLCBvbkNvbm5lY3Rpb25FcnJvcilcbiAgICAgICAgICAgICAgICA7Ly8gLmNhdGNoKG9uQ29ubmVjdGlvbkVycm9yKTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uU3VjY2Vzcyhzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhcGknLCBvcGVyYXRpb24sIHNlcmlhbGl6ZWQsIGZ1bmN0aW9uKHNlcmlhbGl6ZWRSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHRyYW5zcG9ydC5kZXNlcmlhbGl6ZShzZXJpYWxpemVkUmVzdWx0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAocmVzdWx0LmNvZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlYnVnICYmIGNvbnNvbGUuZGVidWcoJ0Vycm9yIG9uICcgKyBvcGVyYXRpb24gKyAnIC0+JyArIEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KHtjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHJlc3VsdC5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25FcnJvcihlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJHEucmVqZWN0KHtjb2RlOiAnQ09OTkVDVElPTl9FUlInLCBkZXNjcmlwdGlvbjogZXJyfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xufVxufSgpKTtcblxuIiwiYW5ndWxhci5tb2R1bGUoJ3plcnYuY29yZScsIFtdKTtcbiIsIlxuLyoqIFxuICogVGhpcyBwcm92aWRlciBoYW5kbGVzIHRoZSBoYW5kc2hha2UgdG8gYXV0aGVudGljYXRlIGEgdXNlciBhbmQgbWFpbnRhaW4gYSBzZWN1cmUgd2ViIHNvY2tldCBjb25uZWN0aW9uIHZpYSB0b2tlbnMuXG4gKiBJdCBhbHNvIHNldHMgdGhlIGxvZ2luIGFuZCBsb2dvdXQgdXJsIHBhcnRpY2lwYXRpbmcgaW4gdGhlIGF1dGhlbnRpY2F0aW9uLlxuICogXG4gKiBcbiAqIHVzYWdlIGV4YW1wbGVzOlxuICogXG4gKiBJbiB0aGUgY29uZmlnIG9mIHRoZSBhcHAgbW9kdWxlOlxuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ2luVXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ291dFVybCgnL2FjY2VzcyMvbG9naW4nKTtcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzKDE1KTtcbiAqIFRoaXMgZGVmaW5lcyBob3cgbXVjaCB0aW1lIHdlIGNhbiB3YWl0IHRvIGVzdGFibGlzaCBhIHN1Y2Nlc3N1bCBjb25uZWN0aW9uIGJlZm9yZSByZWplY3RpbmcgdGhlIGNvbm5lY3Rpb24gKHNvY2tldFNlcnZpY2UuY29ubmVjdElPKSB3aXRoIGEgdGltZW91dC4gYnkgZGVmYXVsdCwgaXQgd2lsbCB0cnkgZm9yIDE1IHNlY29uZHMgdG8gZ2V0IGEgY29ubmVjdGlvbiBhbmQgdGhlbiBnaXZlIHVwXG4gKiAgXG4gKiBCZWZvcmUgYW55IHNvY2tldCB1c2UgaW4geW91ciBzZXJ2aWNlcyBvciByZXNvbHZlIGJsb2NrcywgY29ubmVjdCgpIG1ha2VzIHN1cmUgdGhhdCB3ZSBoYXZlIGFuIGVzdGFibGlzaGVkIGF1dGhlbnRpY2F0ZWQgY29ubmVjdGlvbiBieSB1c2luZyB0aGUgZm9sbG93aW5nOlxuICogc29ja2V0U2VydmljZS5jb25uZWN0KCkudGhlbihcbiAqIGZ1bmN0aW9uKHNvY2tldCl7IC4uLiBzb2NrZXQuZW1pdCgpLi4gfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7Li4ufSlcbiAqIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCd6ZXJ2LmNvcmUnKVxuICAgIC8vIGNvbnZlbmllbnQgc2VydmljZSByZXR1cm5pbmcgc2Vzc2lvblVzZXJcbiAgICAuZmFjdG9yeSgnc2Vzc2lvblVzZXInLCBmdW5jdGlvbigkYXV0aCkge1xuICAgICAgICByZXR1cm4gJGF1dGguZ2V0U2Vzc2lvblVzZXIoKTtcbiAgICB9KVxuICAgIC5wcm92aWRlcignJGF1dGgnLCBhdXRoUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBhdXRoUHJvdmlkZXIoKSB7XG4gICAgdmFyIGxvZ2luVXJsLCBsb2dvdXRVcmwsIGRlYnVnLCByZWNvbm5lY3Rpb25NYXhUaW1lID0gMTU7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dpblVybCA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIGxvZ2luVXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0TG9nb3V0VXJsID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgbG9nb3V0VXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0UmVjb25uZWN0aW9uTWF4VGltZUluU2VjcyA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIHJlY29ubmVjdGlvbk1heFRpbWUgPSB2YWx1ZSAqIDEwMDA7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uKCRyb290U2NvcGUsICRsb2NhdGlvbiwgJHRpbWVvdXQsICRpbnRlcnZhbCwgJHEsICR3aW5kb3cpIHtcbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gcmV0cmlldmVBdXRoQ29kZSgpIHx8IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgY29uc3Qgc2Vzc2lvblVzZXIgPSB7Y29ubmVjdGVkOiBmYWxzZX07XG5cbiAgICAgICAgaWYgKCFsb2NhbFN0b3JhZ2UudG9rZW4pIHtcbiAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2Uub3JpZ2luO1xuICAgICAgICAgICAgLy8gQFRPRE86IHRoaXMgcmlnaHQgd2F5IHRvIHJlZGlyZWN0IGlmIHdlIGhhdmUgbm8gdG9rZW4gd2hlbiB3ZSByZWZyZXNoIG9yIGhpdCB0aGUgYXBwLlxuICAgICAgICAgICAgLy8gIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIC8vIGJ1dCBpdCB3b3VsZCBwcmV2ZW50IG1vc3QgdW5pdCB0ZXN0cyBmcm9tIHJ1bm5pbmcgYmVjYXVzZSB0aGlzIG1vZHVsZSBpcyB0aWdobHkgY291cGxlZCB3aXRoIGFsbCB1bml0IHRlc3RzIChkZXBlbmRzIG9uIGl0KWF0IHRoaXMgdGltZSA6XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29ubmVjdDogY29ubmVjdCxcbiAgICAgICAgICAgIGxvZ291dDogbG9nb3V0LFxuICAgICAgICAgICAgZ2V0U2Vzc2lvblVzZXI6IGdldFNlc3Npb25Vc2VyLFxuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZXNzaW9uVXNlcigpIHtcbiAgICAgICAgICAgIC8vIHRoZSBvYmplY3Qgd2lsbCBoYXZlIHRoZSB1c2VyIGluZm9ybWF0aW9uIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuIE90aGVyd2lzZSBpdHMgY29ubmVjdGlvbiBwcm9wZXJ0eSB3aWxsIGJlIGZhbHNlOyBcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uVXNlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSBcbiAgICAgICAgICogdGhlIHN1Y2Nlc3MgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHNvY2tldCBhcyBhIHBhcmFtZXRlclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY29ubmVjdCgpIHtcbiAgICAgICAgICAgIGlmICghc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0dXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxvZ291dCgpIHtcbiAgICAgICAgICAgIC8vIGNvbm5lY3Rpb24gY291bGQgYmUgbG9zdCBkdXJpbmcgbG9nb3V0Li5zbyBpdCBjb3VsZCBtZWFuIHdlIGhhdmUgbm90IGxvZ291dCBvbiBzZXJ2ZXIgc2lkZS5cbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnbG9nb3V0JywgbG9jYWxTdG9yYWdlLnRva2VuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldEZvclZhbGlkQ29ubmVjdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBiZWluZyB0aGUgc2NlbmUsIHNvY2tldC5pbyBpcyB0cnlpbmcgdG8gcmVjb25uZWN0IGFuZCBhdXRoZW50aWNhdGUgaWYgdGhlIGNvbm5lY3Rpb24gd2FzIGxvc3Q7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0KCkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1VTRVJfTk9UX0NPTk5FQ1RFRCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWNvbm5lY3QoKSB7XG4gICAgICAgICAgICBjb25zdCBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBAVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgY29uc3Qgb2ZmID0gJHJvb3RTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKGFjY2VwdGFibGVEZWxheSkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwoYWNjZXB0YWJsZURlbGF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFjY2VwdGFibGVEZWxheSA9ICR0aW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVElNRU9VVCcpO1xuICAgICAgICAgICAgfSwgcmVjb25uZWN0aW9uTWF4VGltZSk7XG5cbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2V0dXAoKSB7XG4gICAgICAgICAgICBpZiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgLy8gYWxyZWFkeSBjYWxsZWQuLi5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgdG9rZW5WYWxpZGl0eVRpbWVvdXQ7XG4gICAgICAgICAgICAvLyBlc3RhYmxpc2ggY29ubmVjdGlvbiB3aXRob3V0IHBhc3NpbmcgdGhlIHRva2VuIChzbyB0aGF0IGl0IGlzIG5vdCB2aXNpYmxlIGluIHRoZSBsb2cpXG4gICAgICAgICAgICBzb2NrZXQgPSBpby5jb25uZWN0KHtcbiAgICAgICAgICAgICAgICAnZm9yY2VOZXcnOiB0cnVlLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdCcsIG9uQ29ubmVjdClcbiAgICAgICAgICAgICAgICAub24oJ2F1dGhlbnRpY2F0ZWQnLCBvbkF1dGhlbnRpY2F0ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCd1bmF1dGhvcml6ZWQnLCBvblVuYXV0aG9yaXplZClcbiAgICAgICAgICAgICAgICAub24oJ2xvZ2dlZF9vdXQnLCBvbkxvZ091dClcbiAgICAgICAgICAgICAgICAub24oJ2Rpc2Nvbm5lY3QnLCBvbkRpc2Nvbm5lY3QpO1xuXG4gICAgICAgICAgICAvLyBUT0RPOiB0aGlzIGZvbGxvd293aW5nIGV2ZW50IGlzIHN0aWxsIHVzZWQuPz8/Li4uLlxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0X2Vycm9yJywgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgLy8gUGFzcyB0aGUgb3JpZ2luIGlmIGFueSB0byBoYW5kbGUgbXVsdGkgc2Vzc2lvbiBvbiBhIGJyb3dzZXIuXG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNvY2tldCBpcyBjb25uZWN0ZWQsIHRpbWUgdG8gcGFzcyB0aGUgYXV0aCBjb2RlIG9yIGN1cnJlbnQgdG9rZW4gdG8gYXV0aGVudGljYXRlIGFzYXBcbiAgICAgICAgICAgICAgICAvLyBiZWNhdXNlIGlmIGl0IGV4cGlyZXMsIHVzZXIgd2lsbCBoYXZlIHRvIHJlbG9nIGluXG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2F1dGhlbnRpY2F0ZScsIHt0b2tlbjogbG9jYWxTdG9yYWdlLnRva2VuLCBvcmlnaW46IGxvY2FsU3RvcmFnZS5vcmlnaW59KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gbG9jYWxTdG9yYWdlLnRva2VuKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcblxuICAgICAgICAgICAgICAgIC8vIGlkZW50aWZ5IG9yaWdpbiBmb3IgbXVsdGkgc2Vzc2lvblxuICAgICAgICAgICAgICAgIGlmICghbG9jYWxTdG9yYWdlLm9yaWdpbikge1xuICAgICAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2Uub3JpZ2luID0gcmVmcmVzaFRva2VuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHNldExvZ2luVXNlcihyZWZyZXNoVG9rZW4pO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXModHJ1ZSk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbihyZWZyZXNoVG9rZW4pO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9jb25uZWN0ZWQnLCBzZXNzaW9uVXNlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uTG9nT3V0KCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdG9rZW4gaXMgbm8gbG9uZ2VyIGF2YWlsYWJsZS5cbiAgICAgICAgICAgICAgICBkZWxldGUgbG9jYWxTdG9yYWdlLnRva2VuO1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2Uub3JpZ2luO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ291dFVybCB8fCBsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVW5hdXRob3JpemVkKG1zZykge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ3VuYXV0aG9yaXplZDogJyArIEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICByZWRpcmVjdChsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldENvbm5lY3Rpb25TdGF0dXMoY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgc2Vzc2lvblVzZXIuY29ubmVjdGVkID0gY29ubmVjdGVkO1xuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUuZGVidWcoXCJDb25uZWN0aW9uIHN0YXR1czpcIiArIEpTT04uc3RyaW5naWZ5KHNlc3Npb25Vc2VyKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldExvZ2luVXNlcih0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5hc3NpZ24oc2Vzc2lvblVzZXIsIHBheWxvYWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBjbGVhclRva2VuVGltZW91dCgpIHtcbiAgICAgICAgICAgICAgICBpZiAodG9rZW5WYWxpZGl0eVRpbWVvdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKHRva2VuVmFsaWRpdHlUaW1lb3V0KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlY29kZSh0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjRVcmwgPSB0b2tlbi5zcGxpdCgnLicpWzFdO1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjQgPSBiYXNlNjRVcmwucmVwbGFjZSgnLScsICcrJykucmVwbGFjZSgnXycsICcvJyk7XG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBKU09OLnBhcnNlKCR3aW5kb3cuYXRvYihiYXNlNjQpKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGF5bG9hZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbih0b2tlbikge1xuICAgICAgICAgICAgICAgIGlmICh0b2tlblZhbGlkaXR5VGltZW91dCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIHJlcXVlc3QgYSBsaXR0bGUgYmVmb3JlLi4uXG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBkZWNvZGUodG9rZW4sIHtjb21wbGV0ZTogZmFsc2V9KTtcblxuICAgICAgICAgICAgICAgIHZhciBpbml0aWFsID0gcGF5bG9hZC5kdXI7XG5cbiAgICAgICAgICAgICAgICB2YXIgZHVyYXRpb24gPSAoaW5pdGlhbCAqIDkwIC8gMTAwKSB8IDA7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NjaGVkdWxlIHRvIHJlcXVlc3QgYSBuZXcgdG9rZW4gaW4gJyArIGR1cmF0aW9uICsgJyBzZWNvbmRzICh0b2tlbiBkdXJhdGlvbjonICsgaW5pdGlhbCArICcpJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRva2VuVmFsaWRpdHlUaW1lb3V0ID0gJGludGVydmFsKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIHJlIGF1dGhlbnRpY2F0ZSB3aXRoIHRoZSB0b2tlbiBmcm9tIHRoZSBzdG9yYWdlIHNpbmNlIGFub3RoZXIgYnJvd3NlciBjb3VsZCBoYXZlIG1vZGlmaWVkIGl0LlxuICAgICAgICAgICAgICAgICAgICBpZiAoIWxvY2FsU3RvcmFnZS50b2tlbikge1xuICAgICAgICAgICAgICAgICAgICAgICAgb25VbmF1dGhvcml6ZWQoJ1Rva2VuIG5vIGxvbmdlciBhdmFpbGFibGUnKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywge3Rva2VuOiBsb2NhbFN0b3JhZ2UudG9rZW59KTtcbiAgICAgICAgICAgICAgICAgICAgLy8gTm90ZTogSWYgY29tbXVuaWNhdGlvbiBjcmFzaGVzIHJpZ2h0IGFmdGVyIHdlIGVtaXR0ZWQgYW5kIHdoZW4gc2VydmVycyBpcyBzZW5kaW5nIGJhY2sgdGhlIHRva2VuLFxuICAgICAgICAgICAgICAgICAgICAvLyB3aGVuIHRoZSBjbGllbnQgcmVlc3RhYmxpc2hlcyB0aGUgY29ubmVjdGlvbiwgd2Ugd291bGQgaGF2ZSB0byBsb2dpbiBiZWNhdXNlIHRoZSBwcmV2aW91cyB0b2tlbiB3b3VsZCBiZSBpbnZhbGlkYXRlZC5cbiAgICAgICAgICAgICAgICB9LCBkdXJhdGlvbiAqIDEwMDApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmV0cmlldmVBdXRoQ29kZSgpIHtcbiAgICAgICAgICAgIHZhciB1c2VyVG9rZW4gPSAkbG9jYXRpb24uc2VhcmNoKCkudG9rZW47XG4gICAgICAgICAgICBpZiAodXNlclRva2VuICYmIGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnVXNpbmcgQXV0aCBDb2RlIHBhc3NlZCBkdXJpbmcgcmVkaXJlY3Rpb246ICcgKyB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cblxuIiwiXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOICYmICF3aW5kb3cuWkpTT05CSU4uZGlzYWJsZWQgPyB3aW5kb3cuWkpTT05CSU4gOiB7c2VyaWFsaXplOiBub29wLCBkZXNlcmlhbGl6ZTogbm9vcH07XG4gICAgZnVuY3Rpb24gbm9vcCh2KSB7XG4gICAgICAgIHJldHVybiB2O1xuICAgIH1cblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiBzb2NrZXRpb1NlcnZpY2UoJHJvb3RTY29wZSwgJHEsICRhdXRoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvbjogb24sXG4gICAgICAgICAgICBlbWl0OiBlbWl0LFxuICAgICAgICAgICAgbG9nb3V0OiAkYXV0aC5sb2dvdXQsXG4gICAgICAgICAgICBmZXRjaDogZmV0Y2gsXG4gICAgICAgICAgICBwb3N0OiBwb3N0LFxuICAgICAgICAgICAgbm90aWZ5OiBub3RpZnksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgZnVuY3Rpb24gb24oZXZlbnROYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0Lm9uKGV2ZW50TmFtZSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVwcmVjYXRlZCwgdXNlIHBvc3Qvbm90aWZ5XG4gICAgICAgIGZ1bmN0aW9uIGVtaXQoZXZlbnROYW1lLCBkYXRhLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24oc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoZXZlbnROYW1lLCBkYXRhLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmZXRjaCBkYXRhIHRoZSB3YXkgd2UgY2FsbCBhbiBhcGkgXG4gICAgICAgICAqIGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMjA2ODUyMDgvd2Vic29ja2V0LXRyYW5zcG9ydC1yZWxpYWJpbGl0eS1zb2NrZXQtaW8tZGF0YS1sb3NzLWR1cmluZy1yZWNvbm5lY3Rpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBmZXRjaChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ0ZldGNoaW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIG5vdGlmeSBpcyBzaW1pbGFyIHRvIGZldGNoIGJ1dCBtb3JlIG1lYW5pbmdmdWxcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ05vdGlmeWluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBwb3N0IHNlbmRzIGRhdGEgdG8gdGhlIHNlcnZlci5cbiAgICAgICAgICogaWYgZGF0YSB3YXMgYWxyZWFkeSBzdWJtaXR0ZWQsIGl0IHdvdWxkIGp1c3QgcmV0dXJuIC0gd2hpY2ggY291bGQgaGFwcGVuIHdoZW4gaGFuZGxpbmcgZGlzY29ubmVjdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBwb3N0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnUG9zdGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICB2YXIgc2VyaWFsaXplZCA9IHRyYW5zcG9ydC5zZXJpYWxpemUoZGF0YSk7XG5cbiAgICAgICAgICAgIHJldHVybiAkYXV0aC5jb25uZWN0KClcbiAgICAgICAgICAgICAgICAudGhlbihvbkNvbm5lY3Rpb25TdWNjZXNzLCBvbkNvbm5lY3Rpb25FcnJvcilcbiAgICAgICAgICAgICAgICA7Ly8gLmNhdGNoKG9uQ29ubmVjdGlvbkVycm9yKTtcblxuICAgICAgICAgICAgLy8gLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uU3VjY2Vzcyhzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhcGknLCBvcGVyYXRpb24sIHNlcmlhbGl6ZWQsIGZ1bmN0aW9uKHNlcmlhbGl6ZWRSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHRyYW5zcG9ydC5kZXNlcmlhbGl6ZShzZXJpYWxpemVkUmVzdWx0KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAocmVzdWx0LmNvZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlYnVnICYmIGNvbnNvbGUuZGVidWcoJ0Vycm9yIG9uICcgKyBvcGVyYXRpb24gKyAnIC0+JyArIEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KHtjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHJlc3VsdC5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25FcnJvcihlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJHEucmVqZWN0KHtjb2RlOiAnQ09OTkVDVElPTl9FUlInLCBkZXNjcmlwdGlvbjogZXJyfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xufVxuXG4iXX0=

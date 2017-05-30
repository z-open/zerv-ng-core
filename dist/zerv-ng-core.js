(function() {
"use strict";

angular.module('zerv-core', []);
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
    .module('zerv-core')
    // convenient service returning sessionUser
    .factory('sessionUser', ["$auth", function ($auth) {
        return $auth.getSessionUser();
    }])
    .provider('$auth', authProvider);

function authProvider() {

    var loginUrl, logoutUrl, debug, reconnectionMaxTime = 15;

    this.setDebug = function (value) {
        debug = value;
    };

    this.setLoginUrl = function (value) {
        loginUrl = value;
    };

    this.setLogoutUrl = function (value) {
        logoutUrl = value;
    };

    this.setReconnectionMaxTimeInSecs = function (value) {
        reconnectionMaxTime = value * 1000;
    };

    this.$get = ["$rootScope", "$location", "$timeout", "$q", "$window", function ($rootScope, $location, $timeout, $q, $window) {

        var socket;
        var userToken = retrieveToken();
        var sessionUser = { connected: false };

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
            getSessionUser: getSessionUser
        };


        ///////////////////

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
                reconnect().then(function () {
                    deferred.resolve(socket);
                }).catch(function (err) {
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
            //@TODO TO THINK ABOUT:, if the socket is connecting already, means that a connect was called already by another async call, so just wait for user_connected



            // if the response does not come quick..let's give up so we don't get stuck waiting
            // @TODO:other way is to watch for a connection error...
            var acceptableDelay;
            var off = $rootScope.$on('user_connected', function () {
                off();
                if (acceptableDelay) {
                    $timeout.cancel(acceptableDelay);
                }
                deferred.resolve(socket);
            });

            acceptableDelay = $timeout(function () {
                off();
                deferred.reject('TIMEOUT');
            }, reconnectionMaxTime);

            return deferred.promise;
        }

        function setup() {
            if (socket) {
                //already called...
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
                .on('connect_error', function () {
                    setConnectionStatus(false);
                });

            /////////////////////////////////////////////
            function onConnect() {
                // the socket is connected, time to pass the token to authenticate asap
                // because the token is about to expire...if it expires we will have to relog in
                setConnectionStatus(false);
                socket.emit('authenticate', { token: userToken }); // send the jwt
            }

            function onDisconnect() {
                if (debug) { console.debug('Session disconnected'); }
                setConnectionStatus(false);
                $rootScope.$broadcast('user_disconnected');
            }

            function onAuthenticated(refreshToken) {
                clearTokenTimeout();
                // the server confirmed that the token is valid...we are good to go
                if (debug) { console.debug('authenticated, received new token: ' + (refreshToken != userToken)); }
                localStorage.token = refreshToken;
                userToken = refreshToken;
                setLoginUser(userToken);
                setConnectionStatus(true);
                requestNewTokenBeforeExpiration(userToken);
                $rootScope.$broadcast('user_connected',sessionUser);
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
                if (debug) { console.debug('unauthorized: ' + JSON.stringify(msg.data)); }
                setConnectionStatus(false);
                redirect(loginUrl);
            }

            function setConnectionStatus(connected) {
                sessionUser.connected = connected;
                //console.debug("Connection status:" + JSON.stringify(sessionUser));
            }

            function setLoginUser(token) {
                var payload = decode(token);
                return _.assign(sessionUser,payload);
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
                var payload = decode(token, { complete: false });

                var initial = payload.dur;

                var duration = (initial * 90 / 100) | 0;
                if (debug) { console.debug('Schedule to request a new token in ' + duration + ' seconds (token duration:' + initial + ')'); }
                tokenValidityTimeout = $timeout(function () {
                    if (debug) { console.debug('Time to request new token ' + initial); }
                    socket.emit('authenticate', { token: token });
                    // Note: If communication crashes right after we emitted and when servers is sending back the token,
                    // when the client reestablishes the connection, we would have to login because the previous token would be invalidated.
                }, duration * 1000);
            }
        }

        function retrieveToken() {
            var userToken = $location.search().token;
            if (userToken) {
                if (debug) { console.debug('Using token passed during redirection: ' + userToken); }
            } else {
                userToken = localStorage.token;
                if (userToken) {
                    if (debug) { console.debug('Using Token in local storage: ' + userToken); }
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
    .module('zerv-core')
    .provider('$socketio', socketioProvider);

function socketioProvider() {
    var debug;
    this.setDebug = function (value) {
        debug = value;
    };

    this.$get = ["$rootScope", "$q", "$auth", function socketioService($rootScope, $q, $auth) {

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

            return $auth.connect()
                .then(onConnectionSuccess, onConnectionError)
                ;// .catch(onConnectionError);

            ////////////
            function onConnectionSuccess(socket) {
                // but what if we have not connection before the emit, it will queue call...not so good.        
                var deferred = $q.defer();
                socket.emit('api', operation, data, function (result) {
                    if (result.code) {
                        if (debug) { console.debug('Error on ' + operation + ' ->' + JSON.stringify(result)); }
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
    }]
}
}());


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInplcnYtbmctY29yZS5qcyIsInNvY2tldC5tb2R1bGUuanMiLCJzZXJ2aWNlcy9hdXRoLnNlcnZpY2UuanMiLCJzZXJ2aWNlcy9zb2NrZXRpby5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBLFFBQUEsT0FBQSxhQUFBOzs7QURNQSxDQUFDLFdBQVc7QUFDWjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FFYUE7S0FDQSxPQUFBOztLQUVBLFFBQUEseUJBQUEsVUFBQSxPQUFBO1FBQ0EsT0FBQSxNQUFBOztLQUVBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7O0lBRUEsSUFBQSxVQUFBLFdBQUEsT0FBQSxzQkFBQTs7SUFFQSxLQUFBLFdBQUEsVUFBQSxPQUFBO1FBQ0EsUUFBQTs7O0lBR0EsS0FBQSxjQUFBLFVBQUEsT0FBQTtRQUNBLFdBQUE7OztJQUdBLEtBQUEsZUFBQSxVQUFBLE9BQUE7UUFDQSxZQUFBOzs7SUFHQSxLQUFBLCtCQUFBLFVBQUEsT0FBQTtRQUNBLHNCQUFBLFFBQUE7OztJQUdBLEtBQUEsZ0VBQUEsVUFBQSxZQUFBLFdBQUEsVUFBQSxJQUFBLFNBQUE7O1FBRUEsSUFBQTtRQUNBLElBQUEsWUFBQTtRQUNBLElBQUEsY0FBQSxFQUFBLFdBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7Ozs7O2VBS0E7WUFDQSxhQUFBLFFBQUE7O1FBRUEsT0FBQTtZQUNBLFNBQUE7WUFDQSxRQUFBO1lBQ0EsZ0JBQUE7Ozs7OztRQU1BLFNBQUEsaUJBQUE7O1lBRUEsT0FBQTs7Ozs7OztRQU9BLFNBQUEsVUFBQTtZQUNBLElBQUEsQ0FBQSxRQUFBO2dCQUNBOztZQUVBLE9BQUE7OztRQUdBLFNBQUEsU0FBQTs7WUFFQSxJQUFBLFFBQUE7Z0JBQ0EsT0FBQSxLQUFBLFVBQUE7Ozs7UUFJQSxTQUFBLHdCQUFBO1lBQ0EsSUFBQSxXQUFBLEdBQUE7WUFDQSxJQUFBLFlBQUEsV0FBQTtnQkFDQSxTQUFB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V0FBQSxXQUFBLE1BQUE7O1lBRUEsT0FBQSxNQUFBO2lCQUNBLEtBQUEscUJBQUE7Ozs7WUFJQSxTQUFBLG9CQUFBLFFBQUE7O2dCQUVBLElBQUEsV0FBQSxHQUFBO2dCQUNBLE9BQUEsS0FBQSxPQUFBLFdBQUEsTUFBQSxVQUFBLFFBQUE7b0JBQ0EsSUFBQSxPQUFBLE1BQUE7d0JBQ0EsSUFBQSxPQUFBLEVBQUEsUUFBQSxNQUFBLGNBQUEsWUFBQSxRQUFBLEtBQUEsVUFBQTt3QkFDQSxTQUFBLE9BQUEsRUFBQSxNQUFBLE9BQUEsTUFBQSxhQUFBLE9BQUE7O3lCQUVBO3dCQUNBLFNBQUEsUUFBQSxPQUFBOzs7Z0JBR0EsT0FBQSxTQUFBOzs7WUFHQSxTQUFBLGtCQUFBLEtBQUE7Z0JBQ0EsT0FBQSxHQUFBLE9BQUEsRUFBQSxNQUFBLGtCQUFBLGFBQUE7Ozs7Ozs7QUgwUkEiLCJmaWxlIjoiemVydi1uZy1jb3JlLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXIubW9kdWxlKCd6ZXJ2LWNvcmUnLCBbXSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuLyoqIFxuICogVGhpcyBwcm92aWRlciBoYW5kbGVzIHRoZSBoYW5kc2hha2UgdG8gYXV0aGVudGljYXRlIGEgdXNlciBhbmQgbWFpbnRhaW4gYSBzZWN1cmUgd2ViIHNvY2tldCBjb25uZWN0aW9uIHZpYSB0b2tlbnMuXG4gKiBJdCBhbHNvIHNldHMgdGhlIGxvZ2luIGFuZCBsb2dvdXQgdXJsIHBhcnRpY2lwYXRpbmcgaW4gdGhlIGF1dGhlbnRpY2F0aW9uLlxuICogXG4gKiBcbiAqIHVzYWdlIGV4YW1wbGVzOlxuICogXG4gKiBJbiB0aGUgY29uZmlnIG9mIHRoZSBhcHAgbW9kdWxlOlxuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ2luVXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldExvZ291dFVybCgnL2FjY2VzcyMvbG9naW4nKTtcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzKDE1KTtcbiAqIFRoaXMgZGVmaW5lcyBob3cgbXVjaCB0aW1lIHdlIGNhbiB3YWl0IHRvIGVzdGFibGlzaCBhIHN1Y2Nlc3N1bCBjb25uZWN0aW9uIGJlZm9yZSByZWplY3RpbmcgdGhlIGNvbm5lY3Rpb24gKHNvY2tldFNlcnZpY2UuY29ubmVjdElPKSB3aXRoIGEgdGltZW91dC4gYnkgZGVmYXVsdCwgaXQgd2lsbCB0cnkgZm9yIDE1IHNlY29uZHMgdG8gZ2V0IGEgY29ubmVjdGlvbiBhbmQgdGhlbiBnaXZlIHVwXG4gKiAgXG4gKiBCZWZvcmUgYW55IHNvY2tldCB1c2UgaW4geW91ciBzZXJ2aWNlcyBvciByZXNvbHZlIGJsb2NrcywgY29ubmVjdCgpIG1ha2VzIHN1cmUgdGhhdCB3ZSBoYXZlIGFuIGVzdGFibGlzaGVkIGF1dGhlbnRpY2F0ZWQgY29ubmVjdGlvbiBieSB1c2luZyB0aGUgZm9sbG93aW5nOlxuICogc29ja2V0U2VydmljZS5jb25uZWN0KCkudGhlbihcbiAqIGZ1bmN0aW9uKHNvY2tldCl7IC4uLiBzb2NrZXQuZW1pdCgpLi4gfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7Li4ufSlcbiAqIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCd6ZXJ2LWNvcmUnKVxuICAgIC8vIGNvbnZlbmllbnQgc2VydmljZSByZXR1cm5pbmcgc2Vzc2lvblVzZXJcbiAgICAuZmFjdG9yeSgnc2Vzc2lvblVzZXInLCBmdW5jdGlvbiAoJGF1dGgpIHtcbiAgICAgICAgcmV0dXJuICRhdXRoLmdldFNlc3Npb25Vc2VyKCk7XG4gICAgfSlcbiAgICAucHJvdmlkZXIoJyRhdXRoJywgYXV0aFByb3ZpZGVyKTtcblxuZnVuY3Rpb24gYXV0aFByb3ZpZGVyKCkge1xuXG4gICAgdmFyIGxvZ2luVXJsLCBsb2dvdXRVcmwsIGRlYnVnLCByZWNvbm5lY3Rpb25NYXhUaW1lID0gMTU7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0TG9naW5VcmwgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgbG9naW5VcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dvdXRVcmwgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgbG9nb3V0VXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0UmVjb25uZWN0aW9uTWF4VGltZUluU2VjcyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICByZWNvbm5lY3Rpb25NYXhUaW1lID0gdmFsdWUgKiAxMDAwO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiAoJHJvb3RTY29wZSwgJGxvY2F0aW9uLCAkdGltZW91dCwgJHEsICR3aW5kb3cpIHtcblxuICAgICAgICB2YXIgc29ja2V0O1xuICAgICAgICB2YXIgdXNlclRva2VuID0gcmV0cmlldmVUb2tlbigpO1xuICAgICAgICB2YXIgc2Vzc2lvblVzZXIgPSB7IGNvbm5lY3RlZDogZmFsc2UgfTtcblxuICAgICAgICBpZiAoIXVzZXJUb2tlbikge1xuICAgICAgICAgICAgLy8gQFRPRE86IHRoaXMgcmlnaHQgd2F5IHRvIHJlZGlyZWN0IGlmIHdlIGhhdmUgbm8gdG9rZW4gd2hlbiB3ZSByZWZyZXNoIG9yIGhpdCB0aGUgYXBwLlxuICAgICAgICAgICAgLy8gIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIC8vIGJ1dCBpdCB3b3VsZCBwcmV2ZW50IG1vc3QgdW5pdCB0ZXN0cyBmcm9tIHJ1bm5pbmcgYmVjYXVzZSB0aGlzIG1vZHVsZSBpcyB0aWdobHkgY291cGxlZCB3aXRoIGFsbCB1bml0IHRlc3RzIChkZXBlbmRzIG9uIGl0KWF0IHRoaXMgdGltZSA6XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHVzZXJUb2tlbjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29ubmVjdDogY29ubmVjdCxcbiAgICAgICAgICAgIGxvZ291dDogbG9nb3V0LFxuICAgICAgICAgICAgZ2V0U2Vzc2lvblVzZXI6IGdldFNlc3Npb25Vc2VyXG4gICAgICAgIH07XG5cblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0U2Vzc2lvblVzZXIoKSB7XG4gICAgICAgICAgICAvLyB0aGUgb2JqZWN0IHdpbGwgaGF2ZSB0aGUgdXNlciBpbmZvcm1hdGlvbiB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkLiBPdGhlcndpc2UgaXRzIGNvbm5lY3Rpb24gcHJvcGVydHkgd2lsbCBiZSBmYWxzZTsgXG4gICAgICAgICAgICByZXR1cm4gc2Vzc2lvblVzZXI7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgXG4gICAgICAgICAqIHRoZSBzdWNjZXNzIGZ1bmN0aW9uIHJlY2VpdmVzIHRoZSBzb2NrZXQgYXMgYSBwYXJhbWV0ZXJcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGNvbm5lY3QoKSB7XG4gICAgICAgICAgICBpZiAoIXNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNldHVwKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZ2V0Rm9yVmFsaWRDb25uZWN0aW9uKCk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBsb2dvdXQoKSB7XG4gICAgICAgICAgICAvLyBjb25uZWN0aW9uIGNvdWxkIGJlIGxvc3QgZHVyaW5nIGxvZ291dC4uc28gaXQgY291bGQgbWVhbiB3ZSBoYXZlIG5vdCBsb2dvdXQgb24gc2VydmVyIHNpZGUuXG4gICAgICAgICAgICBpZiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2xvZ291dCcsIHVzZXJUb2tlbik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgaWYgKHNlc3Npb25Vc2VyLmNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYmVpbmcgdGhlIHNjZW5lLCBzb2NrZXQuaW8gaXMgdHJ5aW5nIHRvIHJlY29ubmVjdCBhbmQgYXV0aGVudGljYXRlIGlmIHRoZSBjb25uZWN0aW9uIHdhcyBsb3N0O1xuICAgICAgICAgICAgICAgIHJlY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1VTRVJfTk9UX0NPTk5FQ1RFRCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWNvbm5lY3QoKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuXG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy9AVE9ETyBUTyBUSElOSyBBQk9VVDosIGlmIHRoZSBzb2NrZXQgaXMgY29ubmVjdGluZyBhbHJlYWR5LCBtZWFucyB0aGF0IGEgY29ubmVjdCB3YXMgY2FsbGVkIGFscmVhZHkgYnkgYW5vdGhlciBhc3luYyBjYWxsLCBzbyBqdXN0IHdhaXQgZm9yIHVzZXJfY29ubmVjdGVkXG5cblxuXG4gICAgICAgICAgICAvLyBpZiB0aGUgcmVzcG9uc2UgZG9lcyBub3QgY29tZSBxdWljay4ubGV0J3MgZ2l2ZSB1cCBzbyB3ZSBkb24ndCBnZXQgc3R1Y2sgd2FpdGluZ1xuICAgICAgICAgICAgLy8gQFRPRE86b3RoZXIgd2F5IGlzIHRvIHdhdGNoIGZvciBhIGNvbm5lY3Rpb24gZXJyb3IuLi5cbiAgICAgICAgICAgIHZhciBhY2NlcHRhYmxlRGVsYXk7XG4gICAgICAgICAgICB2YXIgb2ZmID0gJHJvb3RTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGlmIChhY2NlcHRhYmxlRGVsYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKGFjY2VwdGFibGVEZWxheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhY2NlcHRhYmxlRGVsYXkgPSAkdGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdUSU1FT1VUJyk7XG4gICAgICAgICAgICB9LCByZWNvbm5lY3Rpb25NYXhUaW1lKTtcblxuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cCgpIHtcbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICAvL2FscmVhZHkgY2FsbGVkLi4uXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIHRva2VuVmFsaWRpdHlUaW1lb3V0O1xuICAgICAgICAgICAgLy8gZXN0YWJsaXNoIGNvbm5lY3Rpb24gd2l0aG91dCBwYXNzaW5nIHRoZSB0b2tlbiAoc28gdGhhdCBpdCBpcyBub3QgdmlzaWJsZSBpbiB0aGUgbG9nKVxuICAgICAgICAgICAgc29ja2V0ID0gaW8uY29ubmVjdCh7XG4gICAgICAgICAgICAgICAgJ2ZvcmNlTmV3JzogdHJ1ZSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3QnLCBvbkNvbm5lY3QpXG4gICAgICAgICAgICAgICAgLm9uKCdhdXRoZW50aWNhdGVkJywgb25BdXRoZW50aWNhdGVkKVxuICAgICAgICAgICAgICAgIC5vbigndW5hdXRob3JpemVkJywgb25VbmF1dGhvcml6ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCdsb2dnZWRfb3V0Jywgb25Mb2dPdXQpXG4gICAgICAgICAgICAgICAgLm9uKCdkaXNjb25uZWN0Jywgb25EaXNjb25uZWN0KTtcblxuICAgICAgICAgICAgLy8gVE9ETzogdGhpcyBmb2xsb3dvd2luZyBldmVudCBpcyBzdGlsbCB1c2VkLj8/Py4uLi5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdF9lcnJvcicsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0KCkge1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzb2NrZXQgaXMgY29ubmVjdGVkLCB0aW1lIHRvIHBhc3MgdGhlIHRva2VuIHRvIGF1dGhlbnRpY2F0ZSBhc2FwXG4gICAgICAgICAgICAgICAgLy8gYmVjYXVzZSB0aGUgdG9rZW4gaXMgYWJvdXQgdG8gZXhwaXJlLi4uaWYgaXQgZXhwaXJlcyB3ZSB3aWxsIGhhdmUgdG8gcmVsb2cgaW5cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywgeyB0b2tlbjogdXNlclRva2VuIH0pOyAvLyBzZW5kIHRoZSBqd3RcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25EaXNjb25uZWN0KCkge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdTZXNzaW9uIGRpc2Nvbm5lY3RlZCcpOyB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkF1dGhlbnRpY2F0ZWQocmVmcmVzaFRva2VuKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc2VydmVyIGNvbmZpcm1lZCB0aGF0IHRoZSB0b2tlbiBpcyB2YWxpZC4uLndlIGFyZSBnb29kIHRvIGdvXG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ2F1dGhlbnRpY2F0ZWQsIHJlY2VpdmVkIG5ldyB0b2tlbjogJyArIChyZWZyZXNoVG9rZW4gIT0gdXNlclRva2VuKSk7IH1cbiAgICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2UudG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgdXNlclRva2VuID0gcmVmcmVzaFRva2VuO1xuICAgICAgICAgICAgICAgIHNldExvZ2luVXNlcih1c2VyVG9rZW4pO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXModHJ1ZSk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbih1c2VyVG9rZW4pO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9jb25uZWN0ZWQnLHNlc3Npb25Vc2VyKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Mb2dPdXQoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICAvLyB0b2tlbiBpcyBubyBsb25nZXIgYXZhaWxhYmxlLlxuICAgICAgICAgICAgICAgIGRlbGV0ZSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9nb3V0VXJsIHx8IGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25VbmF1dGhvcml6ZWQobXNnKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUb2tlblRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygndW5hdXRob3JpemVkOiAnICsgSlNPTi5zdHJpbmdpZnkobXNnLmRhdGEpKTsgfVxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ2luVXJsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Q29ubmVjdGlvblN0YXR1cyhjb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBzZXNzaW9uVXNlci5jb25uZWN0ZWQgPSBjb25uZWN0ZWQ7XG4gICAgICAgICAgICAgICAgLy9jb25zb2xlLmRlYnVnKFwiQ29ubmVjdGlvbiBzdGF0dXM6XCIgKyBKU09OLnN0cmluZ2lmeShzZXNzaW9uVXNlcikpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRMb2dpblVzZXIodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8uYXNzaWduKHNlc3Npb25Vc2VyLHBheWxvYWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBjbGVhclRva2VuVGltZW91dCgpIHtcbiAgICAgICAgICAgICAgICBpZiAodG9rZW5WYWxpZGl0eVRpbWVvdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHRpbWVvdXQuY2FuY2VsKHRva2VuVmFsaWRpdHlUaW1lb3V0KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlY29kZSh0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjRVcmwgPSB0b2tlbi5zcGxpdCgnLicpWzFdO1xuICAgICAgICAgICAgICAgIHZhciBiYXNlNjQgPSBiYXNlNjRVcmwucmVwbGFjZSgnLScsICcrJykucmVwbGFjZSgnXycsICcvJyk7XG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBKU09OLnBhcnNlKCR3aW5kb3cuYXRvYihiYXNlNjQpKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGF5bG9hZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVxdWVzdE5ld1Rva2VuQmVmb3JlRXhwaXJhdGlvbih0b2tlbikge1xuICAgICAgICAgICAgICAgIC8vIHJlcXVlc3QgYSBsaXR0bGUgYmVmb3JlLi4uXG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBkZWNvZGUodG9rZW4sIHsgY29tcGxldGU6IGZhbHNlIH0pO1xuXG4gICAgICAgICAgICAgICAgdmFyIGluaXRpYWwgPSBwYXlsb2FkLmR1cjtcblxuICAgICAgICAgICAgICAgIHZhciBkdXJhdGlvbiA9IChpbml0aWFsICogOTAgLyAxMDApIHwgMDtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnU2NoZWR1bGUgdG8gcmVxdWVzdCBhIG5ldyB0b2tlbiBpbiAnICsgZHVyYXRpb24gKyAnIHNlY29uZHMgKHRva2VuIGR1cmF0aW9uOicgKyBpbml0aWFsICsgJyknKTsgfVxuICAgICAgICAgICAgICAgIHRva2VuVmFsaWRpdHlUaW1lb3V0ID0gJHRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnVGltZSB0byByZXF1ZXN0IG5ldyB0b2tlbiAnICsgaW5pdGlhbCk7IH1cbiAgICAgICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2F1dGhlbnRpY2F0ZScsIHsgdG9rZW46IHRva2VuIH0pO1xuICAgICAgICAgICAgICAgICAgICAvLyBOb3RlOiBJZiBjb21tdW5pY2F0aW9uIGNyYXNoZXMgcmlnaHQgYWZ0ZXIgd2UgZW1pdHRlZCBhbmQgd2hlbiBzZXJ2ZXJzIGlzIHNlbmRpbmcgYmFjayB0aGUgdG9rZW4sXG4gICAgICAgICAgICAgICAgICAgIC8vIHdoZW4gdGhlIGNsaWVudCByZWVzdGFibGlzaGVzIHRoZSBjb25uZWN0aW9uLCB3ZSB3b3VsZCBoYXZlIHRvIGxvZ2luIGJlY2F1c2UgdGhlIHByZXZpb3VzIHRva2VuIHdvdWxkIGJlIGludmFsaWRhdGVkLlxuICAgICAgICAgICAgICAgIH0sIGR1cmF0aW9uICogMTAwMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZXRyaWV2ZVRva2VuKCkge1xuICAgICAgICAgICAgdmFyIHVzZXJUb2tlbiA9ICRsb2NhdGlvbi5zZWFyY2goKS50b2tlbjtcbiAgICAgICAgICAgIGlmICh1c2VyVG9rZW4pIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnVXNpbmcgdG9rZW4gcGFzc2VkIGR1cmluZyByZWRpcmVjdGlvbjogJyArIHVzZXJUb2tlbik7IH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdXNlclRva2VuID0gbG9jYWxTdG9yYWdlLnRva2VuO1xuICAgICAgICAgICAgICAgIGlmICh1c2VyVG9rZW4pIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1VzaW5nIFRva2VuIGluIGxvY2FsIHN0b3JhZ2U6ICcgKyB1c2VyVG9rZW4pOyB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB1c2VyVG9rZW47XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWRpcmVjdCh1cmwpIHtcbiAgICAgICAgICAgIHdpbmRvdy5sb2NhdGlvbi5yZXBsYWNlKHVybCB8fCAnYmFkVXJsLmh0bWwnKTtcbiAgICAgICAgfVxuICAgIH07XG59XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuLyoqIFxuICogVGhpcyBzZXJ2aWNlIGFsbG93cyB5b3VyIGFwcGxpY2F0aW9uIGNvbnRhY3QgdGhlIHdlYnNvY2tldCBhcGkuXG4gKiBcbiAqIEl0IHdpbGwgZW5zdXJlIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgYXZhaWxhYmxlIGFuZCB1c2VyIGlzIGF1dGhlbnRpY2F0ZWQgYmVmb3JlIGZldGNoaW5nIGRhdGEuXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYtY29yZScpXG4gICAgLnByb3ZpZGVyKCckc29ja2V0aW8nLCBzb2NrZXRpb1Byb3ZpZGVyKTtcblxuZnVuY3Rpb24gc29ja2V0aW9Qcm92aWRlcigpIHtcbiAgICB2YXIgZGVidWc7XG4gICAgdGhpcy5zZXREZWJ1ZyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiBzb2NrZXRpb1NlcnZpY2UoJHJvb3RTY29wZSwgJHEsICRhdXRoKSB7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9uOiBvbixcbiAgICAgICAgICAgIGVtaXQ6IGVtaXQsXG4gICAgICAgICAgICBsb2dvdXQ6ICRhdXRoLmxvZ291dCxcbiAgICAgICAgICAgIGZldGNoOiBmZXRjaCxcbiAgICAgICAgICAgIHBvc3Q6IHBvc3QsXG4gICAgICAgICAgICBub3RpZnk6IG5vdGlmeVxuICAgICAgICB9O1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgZnVuY3Rpb24gb24oZXZlbnROYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24gKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5vbihldmVudE5hbWUsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVwcmVjYXRlZCwgdXNlIHBvc3Qvbm90aWZ5XG4gICAgICAgIGZ1bmN0aW9uIGVtaXQoZXZlbnROYW1lLCBkYXRhLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgJGF1dGguY29ubmVjdCgpLnRoZW4oZnVuY3Rpb24gKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KGV2ZW50TmFtZSwgZGF0YSwgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmZXRjaCBkYXRhIHRoZSB3YXkgd2UgY2FsbCBhbiBhcGkgXG4gICAgICAgICAqIGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMjA2ODUyMDgvd2Vic29ja2V0LXRyYW5zcG9ydC1yZWxpYWJpbGl0eS1zb2NrZXQtaW8tZGF0YS1sb3NzLWR1cmluZy1yZWNvbm5lY3Rpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBmZXRjaChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdGZXRjaGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpOyB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpXG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogbm90aWZ5IGlzIHNpbWlsYXIgdG8gZmV0Y2ggYnV0IG1vcmUgbWVhbmluZ2Z1bFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gbm90aWZ5KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ05vdGlmeWluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpOyB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpXG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogcG9zdCBzZW5kcyBkYXRhIHRvIHRoZSBzZXJ2ZXIuXG4gICAgICAgICAqIGlmIGRhdGEgd2FzIGFscmVhZHkgc3VibWl0dGVkLCBpdCB3b3VsZCBqdXN0IHJldHVybiAtIHdoaWNoIGNvdWxkIGhhcHBlbiB3aGVuIGhhbmRsaW5nIGRpc2Nvbm5lY3Rpb24uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcG9zdChvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdQb3N0aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSkge1xuXG4gICAgICAgICAgICByZXR1cm4gJGF1dGguY29ubmVjdCgpXG4gICAgICAgICAgICAgICAgLnRoZW4ob25Db25uZWN0aW9uU3VjY2Vzcywgb25Db25uZWN0aW9uRXJyb3IpXG4gICAgICAgICAgICAgICAgOy8vIC5jYXRjaChvbkNvbm5lY3Rpb25FcnJvcik7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uU3VjY2Vzcyhzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICAvLyBidXQgd2hhdCBpZiB3ZSBoYXZlIG5vdCBjb25uZWN0aW9uIGJlZm9yZSB0aGUgZW1pdCwgaXQgd2lsbCBxdWV1ZSBjYWxsLi4ubm90IHNvIGdvb2QuICAgICAgICBcbiAgICAgICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhcGknLCBvcGVyYXRpb24sIGRhdGEsIGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlc3VsdC5jb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnRXJyb3Igb24gJyArIG9wZXJhdGlvbiArICcgLT4nICsgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCh7IGNvZGU6IHJlc3VsdC5jb2RlLCBkZXNjcmlwdGlvbjogcmVzdWx0LmRhdGEgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHJlc3VsdC5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25FcnJvcihlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJHEucmVqZWN0KHsgY29kZTogJ0NPTk5FQ1RJT05fRVJSJywgZGVzY3JpcHRpb246IGVyciB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cbn0oKSk7XG5cbiIsImFuZ3VsYXIubW9kdWxlKCd6ZXJ2LWNvcmUnLCBbXSk7XG4iLCJcbi8qKiBcbiAqIFRoaXMgcHJvdmlkZXIgaGFuZGxlcyB0aGUgaGFuZHNoYWtlIHRvIGF1dGhlbnRpY2F0ZSBhIHVzZXIgYW5kIG1haW50YWluIGEgc2VjdXJlIHdlYiBzb2NrZXQgY29ubmVjdGlvbiB2aWEgdG9rZW5zLlxuICogSXQgYWxzbyBzZXRzIHRoZSBsb2dpbiBhbmQgbG9nb3V0IHVybCBwYXJ0aWNpcGF0aW5nIGluIHRoZSBhdXRoZW50aWNhdGlvbi5cbiAqIFxuICogXG4gKiB1c2FnZSBleGFtcGxlczpcbiAqIFxuICogSW4gdGhlIGNvbmZpZyBvZiB0aGUgYXBwIG1vZHVsZTpcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRMb2dpblVybCgnL2FjY2VzcyMvbG9naW4nKTtcbiAqIHNvY2tldFNlcnZpY2VQcm92aWRlci5zZXRMb2dvdXRVcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0UmVjb25uZWN0aW9uTWF4VGltZUluU2VjcygxNSk7XG4gKiBUaGlzIGRlZmluZXMgaG93IG11Y2ggdGltZSB3ZSBjYW4gd2FpdCB0byBlc3RhYmxpc2ggYSBzdWNjZXNzdWwgY29ubmVjdGlvbiBiZWZvcmUgcmVqZWN0aW5nIHRoZSBjb25uZWN0aW9uIChzb2NrZXRTZXJ2aWNlLmNvbm5lY3RJTykgd2l0aCBhIHRpbWVvdXQuIGJ5IGRlZmF1bHQsIGl0IHdpbGwgdHJ5IGZvciAxNSBzZWNvbmRzIHRvIGdldCBhIGNvbm5lY3Rpb24gYW5kIHRoZW4gZ2l2ZSB1cFxuICogIFxuICogQmVmb3JlIGFueSBzb2NrZXQgdXNlIGluIHlvdXIgc2VydmljZXMgb3IgcmVzb2x2ZSBibG9ja3MsIGNvbm5lY3QoKSBtYWtlcyBzdXJlIHRoYXQgd2UgaGF2ZSBhbiBlc3RhYmxpc2hlZCBhdXRoZW50aWNhdGVkIGNvbm5lY3Rpb24gYnkgdXNpbmcgdGhlIGZvbGxvd2luZzpcbiAqIHNvY2tldFNlcnZpY2UuY29ubmVjdCgpLnRoZW4oXG4gKiBmdW5jdGlvbihzb2NrZXQpeyAuLi4gc29ja2V0LmVtaXQoKS4uIH0pLmNhdGNoKGZ1bmN0aW9uKGVycikgey4uLn0pXG4gKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi1jb3JlJylcbiAgICAvLyBjb252ZW5pZW50IHNlcnZpY2UgcmV0dXJuaW5nIHNlc3Npb25Vc2VyXG4gICAgLmZhY3RvcnkoJ3Nlc3Npb25Vc2VyJywgZnVuY3Rpb24gKCRhdXRoKSB7XG4gICAgICAgIHJldHVybiAkYXV0aC5nZXRTZXNzaW9uVXNlcigpO1xuICAgIH0pXG4gICAgLnByb3ZpZGVyKCckYXV0aCcsIGF1dGhQcm92aWRlcik7XG5cbmZ1bmN0aW9uIGF1dGhQcm92aWRlcigpIHtcblxuICAgIHZhciBsb2dpblVybCwgbG9nb3V0VXJsLCBkZWJ1ZywgcmVjb25uZWN0aW9uTWF4VGltZSA9IDE1O1xuXG4gICAgdGhpcy5zZXREZWJ1ZyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ2luVXJsID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGxvZ2luVXJsID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuc2V0TG9nb3V0VXJsID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGxvZ291dFVybCA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgcmVjb25uZWN0aW9uTWF4VGltZSA9IHZhbHVlICogMTAwMDtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gKCRyb290U2NvcGUsICRsb2NhdGlvbiwgJHRpbWVvdXQsICRxLCAkd2luZG93KSB7XG5cbiAgICAgICAgdmFyIHNvY2tldDtcbiAgICAgICAgdmFyIHVzZXJUb2tlbiA9IHJldHJpZXZlVG9rZW4oKTtcbiAgICAgICAgdmFyIHNlc3Npb25Vc2VyID0geyBjb25uZWN0ZWQ6IGZhbHNlIH07XG5cbiAgICAgICAgaWYgKCF1c2VyVG9rZW4pIHtcbiAgICAgICAgICAgIC8vIEBUT0RPOiB0aGlzIHJpZ2h0IHdheSB0byByZWRpcmVjdCBpZiB3ZSBoYXZlIG5vIHRva2VuIHdoZW4gd2UgcmVmcmVzaCBvciBoaXQgdGhlIGFwcC5cbiAgICAgICAgICAgIC8vICByZWRpcmVjdChsb2dpblVybCk7XG4gICAgICAgICAgICAvLyBidXQgaXQgd291bGQgcHJldmVudCBtb3N0IHVuaXQgdGVzdHMgZnJvbSBydW5uaW5nIGJlY2F1c2UgdGhpcyBtb2R1bGUgaXMgdGlnaGx5IGNvdXBsZWQgd2l0aCBhbGwgdW5pdCB0ZXN0cyAoZGVwZW5kcyBvbiBpdClhdCB0aGlzIHRpbWUgOlxuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2NhbFN0b3JhZ2UudG9rZW4gPSB1c2VyVG9rZW47XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNvbm5lY3Q6IGNvbm5lY3QsXG4gICAgICAgICAgICBsb2dvdXQ6IGxvZ291dCxcbiAgICAgICAgICAgIGdldFNlc3Npb25Vc2VyOiBnZXRTZXNzaW9uVXNlclxuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGdldFNlc3Npb25Vc2VyKCkge1xuICAgICAgICAgICAgLy8gdGhlIG9iamVjdCB3aWxsIGhhdmUgdGhlIHVzZXIgaW5mb3JtYXRpb24gd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZC4gT3RoZXJ3aXNlIGl0cyBjb25uZWN0aW9uIHByb3BlcnR5IHdpbGwgYmUgZmFsc2U7IFxuICAgICAgICAgICAgcmV0dXJuIHNlc3Npb25Vc2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIFxuICAgICAgICAgKiB0aGUgc3VjY2VzcyBmdW5jdGlvbiByZWNlaXZlcyB0aGUgc29ja2V0IGFzIGEgcGFyYW1ldGVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBjb25uZWN0KCkge1xuICAgICAgICAgICAgaWYgKCFzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzZXR1cCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGdldEZvclZhbGlkQ29ubmVjdGlvbigpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbG9nb3V0KCkge1xuICAgICAgICAgICAgLy8gY29ubmVjdGlvbiBjb3VsZCBiZSBsb3N0IGR1cmluZyBsb2dvdXQuLnNvIGl0IGNvdWxkIG1lYW4gd2UgaGF2ZSBub3QgbG9nb3V0IG9uIHNlcnZlciBzaWRlLlxuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdsb2dvdXQnLCB1c2VyVG9rZW4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0Rm9yVmFsaWRDb25uZWN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGJlaW5nIHRoZSBzY2VuZSwgc29ja2V0LmlvIGlzIHRyeWluZyB0byByZWNvbm5lY3QgYW5kIGF1dGhlbnRpY2F0ZSBpZiB0aGUgY29ubmVjdGlvbiB3YXMgbG9zdDtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdVU0VSX05PVF9DT05ORUNURUQnKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmVjb25uZWN0KCkge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcblxuICAgICAgICAgICAgaWYgKHNlc3Npb25Vc2VyLmNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vQFRPRE8gVE8gVEhJTksgQUJPVVQ6LCBpZiB0aGUgc29ja2V0IGlzIGNvbm5lY3RpbmcgYWxyZWFkeSwgbWVhbnMgdGhhdCBhIGNvbm5lY3Qgd2FzIGNhbGxlZCBhbHJlYWR5IGJ5IGFub3RoZXIgYXN5bmMgY2FsbCwgc28ganVzdCB3YWl0IGZvciB1c2VyX2Nvbm5lY3RlZFxuXG5cblxuICAgICAgICAgICAgLy8gaWYgdGhlIHJlc3BvbnNlIGRvZXMgbm90IGNvbWUgcXVpY2suLmxldCdzIGdpdmUgdXAgc28gd2UgZG9uJ3QgZ2V0IHN0dWNrIHdhaXRpbmdcbiAgICAgICAgICAgIC8vIEBUT0RPOm90aGVyIHdheSBpcyB0byB3YXRjaCBmb3IgYSBjb25uZWN0aW9uIGVycm9yLi4uXG4gICAgICAgICAgICB2YXIgYWNjZXB0YWJsZURlbGF5O1xuICAgICAgICAgICAgdmFyIG9mZiA9ICRyb290U2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoYWNjZXB0YWJsZURlbGF5KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbChhY2NlcHRhYmxlRGVsYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYWNjZXB0YWJsZURlbGF5ID0gJHRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIG9mZigpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVElNRU9VVCcpO1xuICAgICAgICAgICAgfSwgcmVjb25uZWN0aW9uTWF4VGltZSk7XG5cbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2V0dXAoKSB7XG4gICAgICAgICAgICBpZiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgLy9hbHJlYWR5IGNhbGxlZC4uLlxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciB0b2tlblZhbGlkaXR5VGltZW91dDtcbiAgICAgICAgICAgIC8vIGVzdGFibGlzaCBjb25uZWN0aW9uIHdpdGhvdXQgcGFzc2luZyB0aGUgdG9rZW4gKHNvIHRoYXQgaXQgaXMgbm90IHZpc2libGUgaW4gdGhlIGxvZylcbiAgICAgICAgICAgIHNvY2tldCA9IGlvLmNvbm5lY3Qoe1xuICAgICAgICAgICAgICAgICdmb3JjZU5ldyc6IHRydWUsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0Jywgb25Db25uZWN0KVxuICAgICAgICAgICAgICAgIC5vbignYXV0aGVudGljYXRlZCcsIG9uQXV0aGVudGljYXRlZClcbiAgICAgICAgICAgICAgICAub24oJ3VuYXV0aG9yaXplZCcsIG9uVW5hdXRob3JpemVkKVxuICAgICAgICAgICAgICAgIC5vbignbG9nZ2VkX291dCcsIG9uTG9nT3V0KVxuICAgICAgICAgICAgICAgIC5vbignZGlzY29ubmVjdCcsIG9uRGlzY29ubmVjdCk7XG5cbiAgICAgICAgICAgIC8vIFRPRE86IHRoaXMgZm9sbG93b3dpbmcgZXZlbnQgaXMgc3RpbGwgdXNlZC4/Pz8uLi4uXG4gICAgICAgICAgICBzb2NrZXRcbiAgICAgICAgICAgICAgICAub24oJ2Nvbm5lY3RfZXJyb3InLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICAvLyB0aGUgc29ja2V0IGlzIGNvbm5lY3RlZCwgdGltZSB0byBwYXNzIHRoZSB0b2tlbiB0byBhdXRoZW50aWNhdGUgYXNhcFxuICAgICAgICAgICAgICAgIC8vIGJlY2F1c2UgdGhlIHRva2VuIGlzIGFib3V0IHRvIGV4cGlyZS4uLmlmIGl0IGV4cGlyZXMgd2Ugd2lsbCBoYXZlIHRvIHJlbG9nIGluXG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2F1dGhlbnRpY2F0ZScsIHsgdG9rZW46IHVzZXJUb2tlbiB9KTsgLy8gc2VuZCB0aGUgand0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uRGlzY29ubmVjdCgpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnU2Vzc2lvbiBkaXNjb25uZWN0ZWQnKTsgfVxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGJyb2FkY2FzdCgndXNlcl9kaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25BdXRoZW50aWNhdGVkKHJlZnJlc2hUb2tlbikge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNlcnZlciBjb25maXJtZWQgdGhhdCB0aGUgdG9rZW4gaXMgdmFsaWQuLi53ZSBhcmUgZ29vZCB0byBnb1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdhdXRoZW50aWNhdGVkLCByZWNlaXZlZCBuZXcgdG9rZW46ICcgKyAocmVmcmVzaFRva2VuICE9IHVzZXJUb2tlbikpOyB9XG4gICAgICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gcmVmcmVzaFRva2VuO1xuICAgICAgICAgICAgICAgIHVzZXJUb2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICBzZXRMb2dpblVzZXIodXNlclRva2VuKTtcbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKHRydWUpO1xuICAgICAgICAgICAgICAgIHJlcXVlc3ROZXdUb2tlbkJlZm9yZUV4cGlyYXRpb24odXNlclRva2VuKTtcbiAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRicm9hZGNhc3QoJ3VzZXJfY29ubmVjdGVkJyxzZXNzaW9uVXNlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uTG9nT3V0KCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgLy8gdG9rZW4gaXMgbm8gbG9uZ2VyIGF2YWlsYWJsZS5cbiAgICAgICAgICAgICAgICBkZWxldGUgbG9jYWxTdG9yYWdlLnRva2VuO1xuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHJlZGlyZWN0KGxvZ291dFVybCB8fCBsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVW5hdXRob3JpemVkKG1zZykge1xuICAgICAgICAgICAgICAgIGNsZWFyVG9rZW5UaW1lb3V0KCk7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ3VuYXV0aG9yaXplZDogJyArIEpTT04uc3RyaW5naWZ5KG1zZy5kYXRhKSk7IH1cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICByZWRpcmVjdChsb2dpblVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldENvbm5lY3Rpb25TdGF0dXMoY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgc2Vzc2lvblVzZXIuY29ubmVjdGVkID0gY29ubmVjdGVkO1xuICAgICAgICAgICAgICAgIC8vY29uc29sZS5kZWJ1ZyhcIkNvbm5lY3Rpb24gc3RhdHVzOlwiICsgSlNPTi5zdHJpbmdpZnkoc2Vzc2lvblVzZXIpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2V0TG9naW5Vc2VyKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgdmFyIHBheWxvYWQgPSBkZWNvZGUodG9rZW4pO1xuICAgICAgICAgICAgICAgIHJldHVybiBfLmFzc2lnbihzZXNzaW9uVXNlcixwYXlsb2FkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gY2xlYXJUb2tlblRpbWVvdXQoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRva2VuVmFsaWRpdHlUaW1lb3V0KSB7XG4gICAgICAgICAgICAgICAgICAgICR0aW1lb3V0LmNhbmNlbCh0b2tlblZhbGlkaXR5VGltZW91dCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZWNvZGUodG9rZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0VXJsID0gdG9rZW4uc3BsaXQoJy4nKVsxXTtcbiAgICAgICAgICAgICAgICB2YXIgYmFzZTY0ID0gYmFzZTY0VXJsLnJlcGxhY2UoJy0nLCAnKycpLnJlcGxhY2UoJ18nLCAnLycpO1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gSlNPTi5wYXJzZSgkd2luZG93LmF0b2IoYmFzZTY0KSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBheWxvYWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlcXVlc3ROZXdUb2tlbkJlZm9yZUV4cGlyYXRpb24odG9rZW4pIHtcbiAgICAgICAgICAgICAgICAvLyByZXF1ZXN0IGEgbGl0dGxlIGJlZm9yZS4uLlxuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuLCB7IGNvbXBsZXRlOiBmYWxzZSB9KTtcblxuICAgICAgICAgICAgICAgIHZhciBpbml0aWFsID0gcGF5bG9hZC5kdXI7XG5cbiAgICAgICAgICAgICAgICB2YXIgZHVyYXRpb24gPSAoaW5pdGlhbCAqIDkwIC8gMTAwKSB8IDA7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1NjaGVkdWxlIHRvIHJlcXVlc3QgYSBuZXcgdG9rZW4gaW4gJyArIGR1cmF0aW9uICsgJyBzZWNvbmRzICh0b2tlbiBkdXJhdGlvbjonICsgaW5pdGlhbCArICcpJyk7IH1cbiAgICAgICAgICAgICAgICB0b2tlblZhbGlkaXR5VGltZW91dCA9ICR0aW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1RpbWUgdG8gcmVxdWVzdCBuZXcgdG9rZW4gJyArIGluaXRpYWwpOyB9XG4gICAgICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7IHRva2VuOiB0b2tlbiB9KTtcbiAgICAgICAgICAgICAgICAgICAgLy8gTm90ZTogSWYgY29tbXVuaWNhdGlvbiBjcmFzaGVzIHJpZ2h0IGFmdGVyIHdlIGVtaXR0ZWQgYW5kIHdoZW4gc2VydmVycyBpcyBzZW5kaW5nIGJhY2sgdGhlIHRva2VuLFxuICAgICAgICAgICAgICAgICAgICAvLyB3aGVuIHRoZSBjbGllbnQgcmVlc3RhYmxpc2hlcyB0aGUgY29ubmVjdGlvbiwgd2Ugd291bGQgaGF2ZSB0byBsb2dpbiBiZWNhdXNlIHRoZSBwcmV2aW91cyB0b2tlbiB3b3VsZCBiZSBpbnZhbGlkYXRlZC5cbiAgICAgICAgICAgICAgICB9LCBkdXJhdGlvbiAqIDEwMDApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmV0cmlldmVUb2tlbigpIHtcbiAgICAgICAgICAgIHZhciB1c2VyVG9rZW4gPSAkbG9jYXRpb24uc2VhcmNoKCkudG9rZW47XG4gICAgICAgICAgICBpZiAodXNlclRva2VuKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1VzaW5nIHRva2VuIHBhc3NlZCBkdXJpbmcgcmVkaXJlY3Rpb246ICcgKyB1c2VyVG9rZW4pOyB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVzZXJUb2tlbiA9IGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBpZiAodXNlclRva2VuKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdVc2luZyBUb2tlbiBpbiBsb2NhbCBzdG9yYWdlOiAnICsgdXNlclRva2VuKTsgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG5cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdXNlclRva2VuO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmVkaXJlY3QodXJsKSB7XG4gICAgICAgICAgICB3aW5kb3cubG9jYXRpb24ucmVwbGFjZSh1cmwgfHwgJ2JhZFVybC5odG1sJyk7XG4gICAgICAgIH1cbiAgICB9O1xufVxuXG4iLCJcbi8qKiBcbiAqIFRoaXMgc2VydmljZSBhbGxvd3MgeW91ciBhcHBsaWNhdGlvbiBjb250YWN0IHRoZSB3ZWJzb2NrZXQgYXBpLlxuICogXG4gKiBJdCB3aWxsIGVuc3VyZSB0aGF0IHRoZSBjb25uZWN0aW9uIGlzIGF2YWlsYWJsZSBhbmQgdXNlciBpcyBhdXRoZW50aWNhdGVkIGJlZm9yZSBmZXRjaGluZyBkYXRhLlxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCd6ZXJ2LWNvcmUnKVxuICAgIC5wcm92aWRlcignJHNvY2tldGlvJywgc29ja2V0aW9Qcm92aWRlcik7XG5cbmZ1bmN0aW9uIHNvY2tldGlvUHJvdmlkZXIoKSB7XG4gICAgdmFyIGRlYnVnO1xuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc29ja2V0aW9TZXJ2aWNlKCRyb290U2NvcGUsICRxLCAkYXV0aCkge1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvbjogb24sXG4gICAgICAgICAgICBlbWl0OiBlbWl0LFxuICAgICAgICAgICAgbG9nb3V0OiAkYXV0aC5sb2dvdXQsXG4gICAgICAgICAgICBmZXRjaDogZmV0Y2gsXG4gICAgICAgICAgICBwb3N0OiBwb3N0LFxuICAgICAgICAgICAgbm90aWZ5OiBub3RpZnlcbiAgICAgICAgfTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50TmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICRhdXRoLmNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQub24oZXZlbnROYW1lLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIC8vIGRlcHJlY2F0ZWQsIHVzZSBwb3N0L25vdGlmeVxuICAgICAgICBmdW5jdGlvbiBlbWl0KGV2ZW50TmFtZSwgZGF0YSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICRhdXRoLmNvbm5lY3QoKS50aGVuKGZ1bmN0aW9uIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdChldmVudE5hbWUsIGRhdGEsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgICRyb290U2NvcGUuJGFwcGx5KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrLmFwcGx5KHNvY2tldCwgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogZmV0Y2ggZGF0YSB0aGUgd2F5IHdlIGNhbGwgYW4gYXBpIFxuICAgICAgICAgKiBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vcXVlc3Rpb25zLzIwNjg1MjA4L3dlYnNvY2tldC10cmFuc3BvcnQtcmVsaWFiaWxpdHktc29ja2V0LWlvLWRhdGEtbG9zcy1kdXJpbmctcmVjb25uZWN0aW9uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gZmV0Y2gob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnRmV0Y2hpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTsgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIG5vdGlmeSBpcyBzaW1pbGFyIHRvIGZldGNoIGJ1dCBtb3JlIG1lYW5pbmdmdWxcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShvcGVyYXRpb24sIGRhdGEpIHtcbiAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdOb3RpZnlpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTsgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHBvc3Qgc2VuZHMgZGF0YSB0byB0aGUgc2VydmVyLlxuICAgICAgICAgKiBpZiBkYXRhIHdhcyBhbHJlYWR5IHN1Ym1pdHRlZCwgaXQgd291bGQganVzdCByZXR1cm4gLSB3aGljaCBjb3VsZCBoYXBwZW4gd2hlbiBoYW5kbGluZyBkaXNjb25uZWN0aW9uLlxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHBvc3Qob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnUG9zdGluZyAnICsgb3BlcmF0aW9uICsgJy4uLicpOyB9XG4gICAgICAgICAgICByZXR1cm4gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc29ja2V0RW1pdChvcGVyYXRpb24sIGRhdGEpIHtcblxuICAgICAgICAgICAgcmV0dXJuICRhdXRoLmNvbm5lY3QoKVxuICAgICAgICAgICAgICAgIC50aGVuKG9uQ29ubmVjdGlvblN1Y2Nlc3MsIG9uQ29ubmVjdGlvbkVycm9yKVxuICAgICAgICAgICAgICAgIDsvLyAuY2F0Y2gob25Db25uZWN0aW9uRXJyb3IpO1xuXG4gICAgICAgICAgICAvLy8vLy8vLy8vLy9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQ29ubmVjdGlvblN1Y2Nlc3Moc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgLy8gYnV0IHdoYXQgaWYgd2UgaGF2ZSBub3QgY29ubmVjdGlvbiBiZWZvcmUgdGhlIGVtaXQsIGl0IHdpbGwgcXVldWUgY2FsbC4uLm5vdCBzbyBnb29kLiAgICAgICAgXG4gICAgICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXBpJywgb3BlcmF0aW9uLCBkYXRhLCBmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ0Vycm9yIG9uICcgKyBvcGVyYXRpb24gKyAnIC0+JyArIEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoeyBjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHQuZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uRXJyb3IoZXJyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICRxLnJlamVjdCh7IGNvZGU6ICdDT05ORUNUSU9OX0VSUicsIGRlc2NyaXB0aW9uOiBlcnIgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbiJdfQ==

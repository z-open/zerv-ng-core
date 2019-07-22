"use strict";

(function () {
  "use strict";

  angular.module('zerv.core', []);
})();
'use strict';

(function () {
    "use strict";

    /** 
     * This provider handles the handshake to authenticate a user and maintain a secure web socket connection via tokens.
     * It also sets the login and logout url participating in the authentication.
     * 
     * onSessionExpiration will be called when the user session ends (the token expires or cannot be refreshed).
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

    angular.module('zerv.core')
    // convenient service returning sessionUser
    .factory('sessionUser', ["$auth", function ($auth) {
        return $auth.getSessionUser();
    }]).provider('$auth', authProvider);

    function authProvider() {
        var loginUrl = void 0,
            logoutUrl = void 0,
            debug = void 0,
            reconnectionMaxTime = 15,
            onSessionExpirationCallback = void 0,
            onConnectCallback = void 0,
            onDisconnectCallback = void 0;

        this.setDebug = function (value) {
            debug = value;
            return this;
        };

        this.setLoginUrl = function (value) {
            loginUrl = value;
            return this;
        };

        this.setLogoutUrl = function (value) {
            logoutUrl = value;
            return this;
        };

        this.onSessionExpiration = function (callback) {
            onSessionExpirationCallback = callback;
            return this;
        };

        this.onConnect = function (callback) {
            onConnectCallback = callback;
            return this;
        };

        this.onDisconnect = function (callback) {
            onDisconnectCallback = callback;
            return this;
        };

        this.setReconnectionMaxTimeInSecs = function (value) {
            reconnectionMaxTime = value * 1000;
            return this;
        };

        this.$get = ["$rootScope", "$location", "$timeout", "$q", "$window", function ($rootScope, $location, $timeout, $q, $window) {
            var socket = void 0;
            localStorage.token = retrieveAuthCode() || localStorage.token;
            var sessionUser = {
                connected: false,
                initialConnection: null,
                lastConnection: null,
                connectionErrors: 0
            };

            if (!localStorage.token) {
                delete localStorage.origin;
                // @TODO: this right way to redirect if we have no token when we refresh or hit the app.
                //  redirect(loginUrl);
                // but it would prevent most unit tests from running because this module is tighly coupled with all unit tests (depends on it)at this time :
            }

            var service = {
                connect: connect,
                logout: logout,
                getSessionUser: getSessionUser,
                redirect: redirect
            };

            return service;

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
                // @TODO TO THINK ABOUT:, if the socket is connecting already, means that a connect was called already by another async call, so just wait for user_connected


                // if the response does not come quick..let's give up so we don't get stuck waiting
                // @TODO:other way is to watch for a connection error...
                var acceptableDelay = void 0;
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
                    // already called...
                    return;
                }
                var tokenRequestTimeout = void 0,
                    graceTimeout = void 0;
                // establish connection without passing the token (so that it is not visible in the log)
                socket = io.connect({
                    'forceNew': true
                });

                socket.on('connect', onConnect).on('authenticated', onAuthenticated).on('unauthorized', onUnauthorized).on('logged_out', onLogOut).on('disconnect', onDisconnect);

                // TODO: this followowing event is still used.???....
                socket.on('connect_error', function () {
                    setConnectionStatus(false);
                });

                // ///////////////////////////////////////////
                function onConnect() {
                    // Pass the origin if any to handle multi session on a browser.
                    setConnectionStatus(false);
                    // the socket is connected, time to pass the auth code or current token to authenticate asap
                    // because if it expires, user will have to relog in
                    socket.emit('authenticate', { token: localStorage.token, origin: localStorage.origin }); // send the jwt
                }

                function onDisconnect() {
                    if (debug) {
                        console.debug('Session disconnected');
                    }
                    setConnectionStatus(false);
                    $rootScope.$broadcast('user_disconnected');
                }

                function onAuthenticated(refreshToken) {
                    // the server confirmed that the token is valid...we are good to go
                    if (debug) {
                        console.debug('authenticated, received new token: ' + (refreshToken != localStorage.token) + ', currently connected: ' + sessionUser.connected);
                    }
                    localStorage.token = refreshToken;

                    // identify origin for multi session
                    if (!localStorage.origin) {
                        localStorage.origin = refreshToken;
                    }
                    var payload = decode(refreshToken);
                    setLoginUser(payload);

                    if (!sessionUser.connected) {
                        setConnectionStatus(true);
                        $rootScope.$broadcast('user_connected', sessionUser);
                        if (!sessionUser.initialConnection) {
                            sessionUser.initialConnection = new Date();
                        } else {
                            sessionUser.lastConnection = new Date();
                            sessionUser.connectionErrors++;
                            $rootScope.$broadcast('user_reconnected', sessionUser);
                        }
                    }
                    requestNewTokenBeforeExpiration(payload);
                }

                function onLogOut() {
                    clearNewTokenRequestTimeout();
                    // token is no longer available.
                    delete localStorage.token;
                    delete localStorage.origin;
                    setConnectionStatus(false);
                    service.redirect(logoutUrl || loginUrl);
                }

                function onUnauthorized(msg) {
                    clearNewTokenRequestTimeout();
                    if (debug) {
                        console.debug('unauthorized: ' + JSON.stringify(msg));
                    }
                    setConnectionStatus(false);
                    switch (msg) {
                        case 'wrong_user':
                            window.location.reload();
                            break;
                        case 'session_expired':
                            if (onSessionExpirationCallback) {
                                onSessionExpirationCallback();
                                break;
                            }
                        default:
                            service.redirect(loginUrl);
                    }
                }

                function setConnectionStatus(connected) {
                    if (sessionUser.connected !== connected) {
                        sessionUser.connected = connected;
                        if (connected && onConnectCallback) {
                            onConnectCallback(sessionUser);
                        } else if (!connected && onDisconnectCallback) {
                            onDisconnectCallback(sessionUser);
                        }
                        // console.debug("Connection status:" + JSON.stringify(sessionUser));
                    }
                }

                function setLoginUser(payload) {
                    return _.assign(sessionUser, payload);
                }

                function clearNewTokenRequestTimeout() {
                    if (tokenRequestTimeout) {
                        // Avoid the angular $timeout error issue defined here:
                        // https://github.com/angular/angular.js/blob/master/CHANGELOG.md#timeout-due-to
                        try {
                            $timeout.cancel(tokenRequestTimeout);
                        } catch (err) {
                            console.error('Clearing timeout error: ' + String(err));
                        }

                        tokenRequestTimeout = null;

                        try {
                            $timeout.cancel(graceTimeout);
                        } catch (err) {
                            console.error('Clearing timeout error: ' + String(err));
                        }
                    }
                }

                function decode(token) {
                    var base64Url = token.split('.')[1];
                    var base64 = base64Url.replace('-', '+').replace('_', '/');
                    var payload = JSON.parse($window.atob(base64));
                    return payload;
                }

                function requestNewTokenBeforeExpiration(payload) {
                    clearNewTokenRequestTimeout();
                    var expectancy = payload.dur;

                    var duration = expectancy * 50 / 100 | 0;
                    if (debug) {
                        console.debug('Schedule to request a new token in ' + duration + ' seconds (token duration:' + expectancy + ')');
                    }
                    tokenRequestTimeout = $timeout(function () {
                        if (debug) {
                            console.debug('Time to request new token');
                        }
                        // re authenticate with the token from the storage since another browser could have modified it.
                        if (!localStorage.token) {
                            onUnauthorized('Token no longer available');
                        }

                        socket.emit('authenticate', { token: localStorage.token });
                        // Note: If communication crashes right after we emitted and before server sends back the token,
                        // when the client reestablishes the connection, it might be able to authenticate if the token is still valid, otherwise we will be sent back to login.

                        var tokenToRefresh = localStorage.token;
                        // this is the amount of time to retrieve the new token.
                        graceTimeout = $timeout(function () {
                            if (tokenToRefresh === localStorage.token) {
                                // The user session is ended if there is no valid toke
                                onUnauthorized('session_expired');
                            }
                        }, (expectancy - duration) * 1000);
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
                $window.location.replace(url || 'badUrl.html');
            }
        }];
    }
})();
'use strict';

(function () {
    "use strict";

    /** 
     * This service allows your application contact the websocket api.
     * 
     * It will ensure that the connection is available and user is authenticated before fetching data.
     * 
     */

    angular.module('zerv.core').provider('$socketio', socketioProvider);

    function socketioProvider() {
        var debug = void 0;
        var transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : { serialize: noop, deserialize: noop };
        function noop(v) {
            return v;
        }

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

            // /////////////////
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

                return $auth.connect().then(onConnectionSuccess, onConnectionError); // .catch(onConnectionError);

                // //////////
                function onConnectionSuccess(socket) {
                    var deferred = $q.defer();
                    socket.emit('api', operation, serialized, function (serializedResult) {
                        var result = transport.deserialize(serializedResult);

                        if (result.code) {
                            debug && console.debug('Error on ' + operation + ' ->' + JSON.stringify(result));
                            deferred.reject({ code: result.code, description: result.data });
                        } else {
                            deferred.resolve(result.data);
                        }
                    });
                    return deferred.promise;
                }

                function onConnectionError(err) {
                    return $q.reject({ code: 'CONNECTION_ERR', description: err });
                }
            }
        }];
    }
})();
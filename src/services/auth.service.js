
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
    .factory('sessionUser', function($auth) {
        return $auth.getSessionUser();
    })
    .provider('$auth', authProvider);

function authProvider() {
    let loginUrl, logoutUrl, debug, reconnectionMaxTime = 15;

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

    this.$get = function($rootScope, $location, $timeout, $interval, $q, $window) {
        let socket;
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
            const deferred = $q.defer();
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
            let acceptableDelay;
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
            let tokenValidityTimeout;
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
                msg === 'wrong_user' ? window.location.reload() : redirect(loginUrl);
            }

            function setConnectionStatus(connected) {
                sessionUser.connected = connected;
                // console.debug("Connection status:" + JSON.stringify(sessionUser));
            }

            function setLoginUser(token) {
                const payload = decode(token);
                return _.assign(sessionUser, payload);
            }

            function clearTokenTimeout() {
                if (tokenValidityTimeout) {
                    $timeout.cancel(tokenValidityTimeout);
                }
            }

            function decode(token) {
                const base64Url = token.split('.')[1];
                const base64 = base64Url.replace('-', '+').replace('_', '/');
                const payload = JSON.parse($window.atob(base64));
                return payload;
            }

            function requestNewTokenBeforeExpiration(token) {
                if (tokenValidityTimeout) {
                    return;
                }
                // request a little before...
                const payload = decode(token, {complete: false});

                const initial = payload.dur;

                const duration = (initial * 90 / 100) | 0;
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
            const userToken = $location.search().token;
            if (userToken && debug) {
                console.debug('Using Auth Code passed during redirection: ' + userToken);
            }
            return userToken;
        }

        function redirect(url) {
            window.location.replace(url || 'badUrl.html');
        }
    };
}


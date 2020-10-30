
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
angular
    .module('zerv.core')
    // convenient service returning sessionUser
    .factory('sessionUser', function($auth) {
        return $auth.getSessionUser();
    })
    .provider('$auth', authProvider);

function authProvider() {
    let loginUrl;
    let logoutUrl;
    let debug;
    let reconnectionMaxTime = 15;
    let onSessionExpirationCallback;
    let onUnauthorizedCallback;
    let longPolling = false;
    let socketConnectionOptions;
    const listeners = {};

    localStorage.token = retrieveAuthCodeFromUrlOrTokenFromStorage();

    const userInactivityMonitor = createInactiveSessionMonitoring();

    this.setDefaultInactiveSessionTimeoutInMins = (value) => {
        userInactivityMonitor.setTimeoutInMins(value);
        return this;
    };

    this.setDebug = function(value) {
        debug = value;
        return this;
    };

    this.setLoginUrl = function(value) {
        loginUrl = value;
        return this;
    };

    this.setLogoutUrl = function(value) {
        logoutUrl = value;
        return this;
    };

    this.onSessionExpiration = function(callback) {
        onSessionExpirationCallback = callback;
        return this;
    };

    this.onConnect = function(callback) {
        addListener('connect', callback);
        return this;
    };

    this.onDisconnect = function(callback) {
        addListener('disconnect', callback);
        return this;
    };

    this.onSessionTerminated = function(callback) {
        addListener('sessionTerminated', callback);
        return this;
    };

    this.onUnauthorized = function(callback) {
        onUnauthorizedCallback = callback;
        return this;
    };

    this.setReconnectionMaxTimeInSecs = function(value) {
        reconnectionMaxTime = value * 1000;
        return this;
    };

    this.setSocketConnectionOptions = function(obj) {
        socketConnectionOptions = obj;
        return this;
    };

    this.enableLongPolling = function(value) {
        longPolling = value === true;
        return this;
    };

    this.$get = function($rootScope, $timeout, $q, $window) {
        let socket;
        let tokenRequestTimeout;
        let activeSessionTimeout;
        let loggingOut;

        const userSession = {
            connected: false,
            initialConnection: null,
            lastConnection: null,
            connectionErrors: 0,
        };

        if (!localStorage.token) {
            delete localStorage.origin;
            // @TODO: this right way to redirect if we have no token when we refresh or hit the app.
            //  redirectToLogin();
            // but it would prevent most unit tests from running because this module is tighly coupled with all unit tests (depends on it)at this time :
        }

        const service = {
            connect,
            logout,
            getSessionUser,
            exitToUrl,
            redirect,
            setInactiveSessionTimeoutInMins: userInactivityMonitor.setTimeoutInMins,
            getInactiveSessionTimeoutInMins: userInactivityMonitor.getTimeoutInMins,
            getRemainingInactiveTime: userInactivityMonitor.getRemainingTime,
            getRemainingActiveTime,
            addConnectionListener,
            addDisconnectionListener,
            addSessionTerminatedListener,
            decodeToken,
        };

        userInactivityMonitor.onTimeout = () => service.logout('inactive_session_timeout');

        return service;


        function addConnectionListener(callback) {
            return addListener('connect', callback);
        };

        function addDisconnectionListener(callback) {
            return addListener('disconnect', callback);
        };

        function addSessionTerminatedListener(callback) {
            return addListener('sessionTerminated', callback);
        };

        function getSessionUser() {
            // the object will have the user information when the connection is established. Otherwise its connection property will be false;
            return userSession;
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
            // backend will logged out on inactivity anyway
            if (socket) {
                socket.emit('logout', localStorage.token);
            }
            // let's keep logging out on the front end anyway
            // get it rid of the session state data
            // so that it cannot be reused to gain access.
            onLogOut();
        }

        function getForValidConnection() {
            const deferred = $q.defer();
            // The socket might be no longer physically connected
            // but since the PING PONG has not happened yet, it is believed to be connected.
            if (userSession.connected) {
                deferred.resolve(socket);
            } else {
                // In this case, it is obvious that the connection was lost.
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

            if (userSession.connected) {
                deferred.resolve(socket);
            }
            let acceptableDelay = null;
            const off = $rootScope.$on('user_connected', function() {
                off();
                if (acceptableDelay) {
                    $timeout.cancel(acceptableDelay);
                }
                deferred.resolve(socket);
            });

            // if the response does not come quick..let's give up so that users don't get stuck waiting
            // and the process relying on the reconnect() does not get stuck undefinitely.
            acceptableDelay = $timeout(function() {
                off();
                deferred.reject('TIMEOUT');
            }, reconnectionMaxTime);

            socket.connect();

            return deferred.promise;
        }

        function setup() {
            if (socket) {
                // already called...
                return;
            }
            // establish connection without passing the token (so that it is not visible in the log)
            // and keep the connection alive
            const connectOptions = _.assign( socketConnectionOptions || {},
                {
                    'forceNew': true,
                    // by default the socket will reconnect after any disconnection error (except if disconnect co
                    // default value: https://socket.io/docs/client-api/#new-Manager-url-options

                    // reconnectionAttempts: Infinity - number of reconnection attempts before giving up
                    // reconnectionDelay:1000 how long to initially wait before attempting a new reconnection. Affected by +/- randomizationFactor, for example the default initial delay will be between 500 to 1500ms.
                    // reconnectionDelayMax:5000 maximum amount of time to wait between reconnections. Each attempt increases the reconnection delay by 2x along with a randomization factor.
                    // randomizationFactor:0.5 0 <= randomizationFactor <= 1
                    // timeout:20000 connection timeout before a connect_error and connect_timeout events are emitted
                    // autoConnect:true by setting this false, you have to call manager.open whenever you decide it’s appropriate
                }
            );
            // When using long polling the load balancer must be set to you sticky session to establish the socket connection
            // io client would initiate first the connection with long polling then upgrade to websocket.
            if (longPolling !== true) {
                connectOptions.transports = ['websocket'];
            }
            socket = io.connect(connectOptions);

            socket
                .on('connect', onConnect)
                .on('authenticated', onAuthenticated)
                .on('unauthorized', onUnauthorized)
                .on('logged_out', onLogOut)
                .on('disconnect', onDisconnect);

            socket
                .on('connect_error', function(reason) {
                    // issue during connection
                    setConnectionStatus(false, reason);
                });

            // ///////////////////////////////////////////
            function onConnect() {
                // Pass the origin if any to handle multi session on a browser.
                setConnectionStatus(false, 'Authenticating');
                // the socket is connected, time to pass the auth code or current token to authenticate asap
                // because if it expires, user will have to relog in
                socket.emit('authenticate', {token: localStorage.token, origin: localStorage.origin || null}); // send the jwt
            }

            function onDisconnect(reason) {
                // Reasons:
                // - "ping timeout"    - network issue - define in socketio at 20secs
                // - "transport close" - server closed the socket  (logout will not have time to trigger onDisconnect)
                setConnectionStatus(false, reason);
                $rootScope.$broadcast('user_disconnected');
                // after the socket disconnect, socketio will reconnect the server automatically by default.
                // EXCEPT if the backend sends a disconnect.
                // Currently backend might send a disconnect
                // - if the token is invalid (unauthorized)
                //   -> the onUnauthorized() function will be called as well
                // - if the browser took too much time before requesting authentication (in socketio-jwt)
                //   -> Not handled yet -> futur solution is logout/ clear token
                //
            }

            function onAuthenticated(refreshToken, ackFn) {
                // identify origin for multi session
                if (!localStorage.origin) {
                    localStorage.origin = refreshToken;
                }
                const payload = service.decodeToken(refreshToken);

                // the server confirmed that the token is valid...we are good to go
                if (debug) {
                    // jti: is the number of times it was refreshed
                    console.debug(`AUTH(debug): authenticated, received new token (jti:${payload.jti}): ${refreshToken != localStorage.token}, currently connected: ${userSession.connected}`);
                }
                localStorage.token = refreshToken;
                // if the backend does not receive the acknowlegment due to network error (the token will not be revoked)
                // the token can be still used until expiration and proper reconnection will happen (user will not get kicked out)
                ackFn('OK');

                setLoginUser(payload);
                monitorActiveSessionTimeout();

                if (!userSession.connected) {
                    setConnectionStatus(true);
                    $rootScope.$broadcast('user_connected', userSession);
                    if (!userSession.initialConnection) {
                        userSession.initialConnection = new Date();
                    } else {
                        userSession.lastConnection = new Date();
                        userSession.connectionErrors++;
                        $rootScope.$broadcast('user_reconnected', userSession);
                    }
                }

                userInactivityMonitor.start(() => {
                    notifyUserActivityToBackend(socket);
                });

                scheduleRefreshToken(payload);
            }

            function monitorActiveSessionTimeout() {
                if (!activeSessionTimeout) {
                    // if the client does not have the proper time, the logout initiated from the client side might be off (too early or too late)
                    let remainingActiveSessionTime = service.getRemainingActiveTime();
                    if (remainingActiveSessionTime < 0) {
                        remainingActiveSessionTime = 5000;
                        // let's give a few seconds, so that developer can check the console
                        // and understand that there is an issue with the time
                        // anyway the server tracks the time as well and will log out the user at proper time as well
                        console.error('AUTH(error): Client machine time might be off');
                    }
                    activeSessionTimeout = setTimeout(() => {
                        console.debug('AUTH(debug): Session is expired. Logging out...');
                        service.logout('session_expired');
                    }, remainingActiveSessionTime);
                }
            }

            function onUnauthorized(msg) {
                clearNewTokenRequestTimeout();
                if (debug) {
                    console.debug('AUTH(debug): unauthorized: ' + JSON.stringify(msg));
                }
                setConnectionStatus(false, 'unauthorized');
                if (onUnauthorizedCallback) {
                    onUnauthorizedCallback(msg);
                }
                switch (msg) {
                case 'wrong_user':
                    window.location.reload();
                    break;
                case 'session_expired':
                    // wrong!!!
                    if (onSessionExpirationCallback) {
                        onSessionExpirationCallback();
                        break;
                    }
                default:
                    redirectToLogin();
                }
            }

            function setLoginUser(payload) {
                let sessionRange = null;
                if (userSession.iat !== payload.iat || userSession.exp !== payload.exp) {
                    sessionRange = {
                        sessionStart: new Date(payload.iat * 1000),
                        sessionEnd: new Date(payload.exp * 1000),
                        sessionDuration: payload.exp - payload.iat,
                    };

                    console.debug(`AUTH(debug): User session started on ${sessionRange.sessionStart} and will end on ${sessionRange.sessionEnd} - duration: ${(sessionRange.sessionDuration / 60).toFixed(1)} min(s)`);
                }
                _.assign(userSession, payload, sessionRange);
                return userSession;
            }

            function scheduleRefreshToken(payload) {
                clearNewTokenRequestTimeout();
                // To revise later on :
                // --------------------
                // Rare but all tabs might refresh a token at the same time.
                // risk to get kicked out!
                const duration = payload.dur;
                if (debug) {
                    console.debug('AUTH(debug): Schedule to request a new token in ' + duration );
                }

                tokenRequestTimeout = $timeout(function() {
                    if (debug) {
                        console.debug('AUTH(debug): Time to request new token');
                    }
                    // re authenticate with the token from the storage since another browser could have modified it.
                    if (!localStorage.token) {
                        onUnauthorized('Token no longer available');
                    }
                    socket.emit('authenticate', {token: localStorage.token});
                    // Note: If communication crashes right after we emitted and before server sends back the token,
                    // when the client reestablishes the connection, it might be able to authenticate if the token is still valid, otherwise we will be sent back to login.
                }, duration * 1000);
            }
        }

        function decodeToken(token) {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace('-', '+').replace('_', '/');
            const payload = JSON.parse($window.atob(base64));
            return payload;
        }

        function getRemainingActiveTime() {
            // session has not received any token data yet.
            if (!userSession.exp) {
                return null;
            }
            return (userSession.exp * 1000) - Date.now();
        }

        function onLogOut() {
            if (loggingOut) {
                // the logout has already started
                // initiated by the client or the server
                return;
            }
            loggingOut = true;
            clearNewTokenRequestTimeout();
            setConnectionStatus(false, 'logged out');
            service.exitToUrl(logoutUrl || loginUrl);
        }

        function setConnectionStatus(connected, reason) {
            if (userSession.connected !== connected) {
                if (debug) {
                    console.debug('AUTH(debug): Session Status: ' + (connected ? 'connected' : 'disconnected(' + reason + ')'));
                }
                userSession.connected = connected;
                if (connected) {
                    notifyListeners('connect', userSession);
                } else {
                    notifyListeners('disconnect', userSession);
                }
            }
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
            }
        }

        function exitToUrl(url) {
            // token is no longer needed.
            delete localStorage.token;
            delete localStorage.origin;
            notifyListeners('sessionTerminated', userSession);
            // if the network is disconnected, the redirect will not work.
            setTimeout(() => {
                service.redirect(url);
            }, 5000);
        }

        function redirect(url) {
            $window.location.replace(url || 'badUrl.html');
        }

        function redirectToLogin() {
            const url = window.location.protocol + '//' + window.location.host + loginUrl + '?to=' + encodeURIComponent(window.location.href);
            service.exitToUrl(url);
        }
    };

    function notifyUserActivityToBackend(socket) {
        const lastNotif = Number(localStorage.lastNu || 0);
        const now = Date.now() / 1000;
        if ( now - lastNotif >= 30) {
            localStorage.lastNu = now;
            socket.emit('activity');
        }
    }

    function createInactiveSessionMonitoring() {
        const maxInactiveTimeout = 7 * 24 * 60;

        const monitor = {
            timeoutId: null,
            timeoutInMins: 0,
            started: false,
            onTimeout: null,
        };

        // as soon as there is a user activity the timeout will be resetted but not more than once every sec.
        const notifyUserActivity = _.throttle(
            () => {
                debug && console.debug('AUTH(debug): User activity detected');
                resetMonitor();
                monitor.onActivityDetected();
            },
            1000,
            {leading: true, trailing: false}
        );

        monitor.start = (onActivityDetected) => {
            if (!monitor.started) {
                monitor.onActivityDetected = onActivityDetected;
                monitor.started = true;
                document.addEventListener('mousemove', notifyUserActivity, false);
                document.addEventListener('mousedown', notifyUserActivity, false);
                document.addEventListener('keypress', notifyUserActivity, false);
                document.addEventListener('touchmove', notifyUserActivity, false);
                resetMonitor();
            }
        };

        monitor.setTimeoutInMins = (value) => {
            if (!_.isInteger(value)) {
                value = parseInt(value);
            }
            if (!isNaN(value)) {
                if (value > maxInactiveTimeout || value < 0) {
                    monitor.timeoutInMins = maxInactiveTimeout;
                } else {
                    // value cannot be less than 1 minute otherwise it is disabled to prevent users from being kicked out too early.
                    monitor.timeoutInMins = value < 1 ? 0 : value;
                }
                if (monitor.started) {
                    resetMonitor();
                }
            }
        };

        monitor.getTimeoutInMins = () => {
            return monitor.timeoutInMins;
        };

        monitor.getRemainingTime = () => {
            const inactiveTime = Date.now() - localStorage.lastActivity;
            return (60000 * monitor.timeoutInMins) - inactiveTime;
        };

        function resetMonitor() {
            localStorage.lastActivity = Date.now();
            window.clearTimeout(monitor.timeoutId);
            if (monitor.timeoutInMins !== 0) {
                debug && console.debug(`AUTH(debug): User inactivity timeout resetted to ${monitor.timeoutInMins} mins.`);
                monitor.timeoutId = window.setTimeout(setMonitorTimeout, monitor.timeoutInMins * 60000);
            }
        };

        function setMonitorTimeout() {
            const timeBeforeTimeout = monitor.getRemainingTime();
            if (timeBeforeTimeout <= 0) {
                monitor.onTimeout();
            } else {
                // still need to wait, user was active in another tab
                // This tab must take in consideration the last activity
                debug && console.debug(`AUTH(debug): User was active in another tab, wait ${timeBeforeTimeout/1000} secs more before timing out`);
                monitor.timeoutId = window.setTimeout(monitor._timeout, timeBeforeTimeout);
            }
        };
        return monitor;
    }

    function retrieveAuthCodeFromUrlOrTokenFromStorage() {
    // token will alsway come last in the url if any.
        let pos = window.location.href.indexOf('token=');
        if (pos !== -1) {
            const url = window.location.href.substring(0, pos);
            pos += 6;
            localStorage.token = window.location.href.substring(pos);
            if (debug) {
                console.debug('AUTH(debug): Using Auth Code passed during redirection: ' + localStorage.token);
            }
            window.history.replaceState({}, document.title, url);
        }
        return localStorage.token;
    }

    function addListener(type, callback) {
        const id = type + Date.now();
        let typeListeners = listeners[type];
        if (!typeListeners) {
            typeListeners = listeners[type] = {};
        }
        typeListeners[id] = callback;
        return () => {
            delete typeListeners[id];
        };
    }

    function notifyListeners(type, ...params) {
        _.forEach(listeners[type], (callback) => callback(...params));
    }
}

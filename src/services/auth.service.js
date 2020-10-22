
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
    let loginUrl, logoutUrl, debug, reconnectionMaxTime = 15, onSessionExpirationCallback, onUnauthorizedCallback;
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

    this.$get = function($rootScope, $location, $timeout, $q, $window) {
        let socket;

        const sessionUser = {
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
            redirect,
            setInactiveSessionTimeoutInMins: userInactivityMonitor.setTimeoutInMins,
            getRemainingInactiveTime: userInactivityMonitor.getRemainingTime,
            addConnectionListener,
            addDisconnectionListener,
        };

        userInactivityMonitor.onTimeout = () => service.logout('inactive_session_timeout');

        return service;


        function addConnectionListener(callback) {
            return addListener('connect', callback);
        };

        function addDisconnectionListener(callback) {
            return addListener('disconnect', callback);
        };

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
            // The socket might be no longer physically connected
            // but since the PING PONG has not happened yet, it is believed to be connected.
            if (sessionUser.connected) {
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

            if (sessionUser.connected) {
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
            let tokenRequestTimeout;
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
                socket.emit('authenticate', {token: localStorage.token, origin: localStorage.origin}); // send the jwt
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
                const payload = decode(refreshToken);

                // the server confirmed that the token is valid...we are good to go
                if (debug) {
                    // jti: is the number of times it was refreshed
                    console.debug(`AUTH(debug): authenticated, received new token (jti:${payload.jti}): ${refreshToken != localStorage.token}, currently connected: ${sessionUser.connected}`);
                }
                localStorage.token = refreshToken;
                // if the backend does not receive the acknowlegment due to network error (the token will not be revoked)
                // the token can be still used until expiration and proper reconnection will happen (user will not be kicked out)
                ackFn();

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


                userInactivityMonitor.start(() => {
                    notifyUserActivityToBackend(socket);
                });

                requestNewTokenBeforeExpiration(payload);
            }

            function onLogOut() {
                clearNewTokenRequestTimeout();
                // token is no longer available.
                delete localStorage.token;
                delete localStorage.origin;
                setConnectionStatus(false, 'logged out');
                service.redirect(logoutUrl || loginUrl);
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
                    if (onSessionExpirationCallback) {
                        onSessionExpirationCallback();
                        break;
                    }
                default:
                    redirectToLogin();
                }
            }

            function setConnectionStatus(connected, reason) {
                if (debug) {
                    console.debug('AUTH(debug): Session Status: ' + (connected ? 'connected' : 'disconnected(' + reason + ')'));
                }
                if (sessionUser.connected !== connected) {
                    sessionUser.connected = connected;
                    if (connected) {
                        notifyListeners('connect', sessionUser);
                    } else {
                        notifyListeners('disconnect', sessionUser);
                    }
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
                }
            }

            function decode(token) {
                const base64Url = token.split('.')[1];
                const base64 = base64Url.replace('-', '+').replace('_', '/');
                const payload = JSON.parse($window.atob(base64));
                return payload;
            }

            function requestNewTokenBeforeExpiration(payload) {
                clearNewTokenRequestTimeout();
                const expectancy = payload.dur;
                // if the network is lost just before the token is automatially refreshed
                // but socketio reconnects before the token expired
                // a new token will be provided and session is maintained.
                // To revise:
                // ----------
                // Currently, each reconnection will return a new token
                // Later on, it might be better the backend returns a new token only when it gets closer to expiration
                // it seems a waste of resources (many token blacklisted by zerv-core when poor connection)
                const duration = (expectancy * 50 / 100) | 0;
                if (debug) {
                    console.debug('AUTH(debug): Schedule to request a new token in ' + duration + ' seconds (token duration:' + expectancy + ')');
                }

                // potential issue
                // if there is logout initiated on one tab,
                // but the other tab will not received the logout right away from server
                // and might read the token during the refresh, keeping some tab logged in!
                // could it be???

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

        function redirect(url) {
            $window.location.replace(url || 'badUrl.html');
        }

        function redirectToLogin() {
            const url = window.location.protocol + '//' + window.location.host + loginUrl + '?to=' + encodeURIComponent(window.location.href);
            service.redirect(url);
        }
    };
    /**
 *
 *
 *
 * sockets out perform http


 when a tab detects an activity, it stores it in localStorage.lastActivity
 so that other tab can recompute their timeout.

 a webworker could have been better.
 each time there is activity, it will be notified to web worker


 when user closes the browser
 the token is no longer refreshed but valid for its time.

 if user reopen browser being inactive for more than the inactive session timeout

zimit should take user to sso


current the user can still go in since the token is valid even if not login in SSO
the session was inactive and should have expired.


solution using token expiration is not precised
------------------------------------------------
token expiration is set to session inactive timeout SIT
if the user closes browser,
- since token is refreshed SIT of remaining time
 to get a session, user must reopen browser between SIT / 2 and SIT

 - if browser disconnect/close just before SIT/2, it must reconnect in that interval to keep session
   if user is not active until right before SIT but then become active
   and connection come back
   the toke will have already expired
   , user will get kicked out.

Seems the easiest solution
the more time a browser is disonnected the more chance the user has to get kick out on reconection.
the bad is quite a few token will be blacklisted.


in backend, read the session timeout from the tenant, a get method

on front end, be careful not have multiple tabs asking for refresh.
use same monitoring strategy than session inactive timeout for all tabs to try to sync at the same time
but only one send the token.
SIT/3 might be better.

session inactive timeout is not to confuse with app auto lock.


solution using active signal (work on both ends)
-----------------------------
when user is active, send msg every minute
backend update last time of activity in the global session
if disconnected (by network failure) or browser closed, msg is not sent
when the browser is reopen or reconnect
and if the token is still valid (token expiration should 2 times SIT)
find if there is an active session
if yes, check the last time it was active
if longer than SIT, then black list token for time more than active session timeout
and logout


Question
if the user has closed all the browser tabs, why do we keep the session active based on session timeout? let's close the session after a while, user is gone.
when socket close is received, store in global sessionId close time


if the browser has lost connection, how long should we keep the session valid?
connection might come back anytime, if the token expires, and connection returns, user will get kicked out
with no connection cannot work.


HOW TO BLACKLIST A VALID TOKEN AFTER DETECTING INACTIVITY (NO SOCKET CONNECTION) ON SERVER
IF THERE IS NO OTHER LOCAL SESSION ON OTHER SERVER WITH THIS TOKEN


solution
if user closes the browser

if browser gets disconnected

???

token refresh form one tab.


BEST?
With http, when the request is made server returns result or session timeout.


with socket,

other Solution
--------
when the user uses a token
if blacklisted then
    deny
check if the token is  the initial token (token auth code, which would not have a global session)
    authenticate, create local and global session
else
    if global session does NOT exists,
        // weird the token should have been black list
        deny
    else
        //check the last update (UI sends update)
        if last update is after session inactive timeout
            then reject and black list and remove global session
            PRBL the session will be available even though no browser tab is opened.

        else
            allow


Solution
---------
1. when the user closes the browser or all tabs manually
save in the global session when the last one was closed but remove when a new tab is opened (new connection)
when user tries to reconnect with a still valid token
if the global session exists and the last tab close was X minutes ago, black list and reject

this is nice because we can release the session quickly, knowning that the user intently closed zimit.

2. the user did not close the tabs but the network is gone or computer crashed (no way to know)
when computer reconnect with a still valid token
if a global session exits and was not updated recently, then reject and blacklist, remove session

the session will remain available for up to the session inactive timeout duration when the network is disconnected


 */
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
                if (value > maxInactiveTimeout) {
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

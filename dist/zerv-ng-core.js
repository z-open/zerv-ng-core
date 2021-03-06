"use strict";

(function () {
  angular.module('zerv.core', []);
})();
"use strict";

(function () {
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
  angular.module('zerv.core') // convenient service returning sessionUser
  .factory('sessionUser', ["$auth", function ($auth) {
    return $auth.getSessionUser();
  }]).provider('$auth', authProvider);

  function authProvider() {
    var _this = this;

    var loginUrl = void 0;
    var logoutUrl = void 0;
    var debug = void 0;
    var reconnectionMaxTime = 15;
    var onSessionExpirationCallback = void 0;
    var onUnauthorizedCallback = void 0;
    var longPolling = false;
    var socketConnectionOptions = void 0;
    var listeners = {};
    localStorage.token = retrieveAuthCodeFromUrlOrTokenFromStorage();
    var userInactivityMonitor = createInactiveSessionMonitoring();

    this.setDefaultInactiveSessionTimeoutInMins = function (value) {
      userInactivityMonitor.setTimeoutInMins(value);
      return _this;
    };

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
      addListener('connect', callback);
      return this;
    };

    this.onDisconnect = function (callback) {
      addListener('disconnect', callback);
      return this;
    };

    this.onSessionTerminated = function (callback) {
      addListener('sessionTerminated', callback);
      return this;
    };

    this.onUnauthorized = function (callback) {
      onUnauthorizedCallback = callback;
      return this;
    };

    this.setReconnectionMaxTimeInSecs = function (value) {
      reconnectionMaxTime = value * 1000;
      return this;
    };

    this.setSocketConnectionOptions = function (obj) {
      socketConnectionOptions = obj;
      return this;
    };

    this.enableLongPolling = function (value) {
      longPolling = value === true;
      return this;
    };

    this.$get = ["$rootScope", "$timeout", "$q", "$window", function ($rootScope, $timeout, $q, $window) {
      var socket = void 0;
      var tokenRequestTimeout = void 0;
      var activeSessionTimeout = void 0;
      var loggingOut = void 0;
      var userSession = {
        connected: false,
        initialConnection: null,
        lastConnection: null,
        connectionErrors: 0
      };

      if (!localStorage.token) {
        delete localStorage.origin; // @TODO: this right way to redirect if we have no token when we refresh or hit the app.
        //  redirectToLogin();
        // but it would prevent most unit tests from running because this module is tighly coupled with all unit tests (depends on it)at this time :
      }

      var service = {
        connect: connect,
        logout: logout,
        getSessionUser: getSessionUser,
        exitToUrl: exitToUrl,
        redirect: redirect,
        setInactiveSessionTimeoutInMins: userInactivityMonitor.setTimeoutInMins,
        getInactiveSessionTimeoutInMins: userInactivityMonitor.getTimeoutInMins,
        getRemainingInactiveTime: userInactivityMonitor.getRemainingTime,
        getRemainingActiveTime: getRemainingActiveTime,
        addConnectionListener: addConnectionListener,
        addDisconnectionListener: addDisconnectionListener,
        addSessionTerminatedListener: addSessionTerminatedListener,
        decodeToken: decodeToken
      };

      userInactivityMonitor.onTimeout = function () {
        return service.logout('inactive_session_timeout');
      };

      return service;

      function addConnectionListener(callback) {
        return addListener('connect', callback);
      }

      ;

      function addDisconnectionListener(callback) {
        return addListener('disconnect', callback);
      }

      ;

      function addSessionTerminatedListener(callback) {
        return addListener('sessionTerminated', callback);
      }

      ;

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
        } // let's keep logging out on the front end anyway
        // get it rid of the session state data
        // so that it cannot be reused to gain access.


        onLogOut();
      }

      function getForValidConnection() {
        var deferred = $q.defer(); // The socket might be no longer physically connected
        // but since the PING PONG has not happened yet, it is believed to be connected.

        if (userSession.connected) {
          deferred.resolve(socket);
        } else {
          // In this case, it is obvious that the connection was lost.
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

        if (userSession.connected) {
          deferred.resolve(socket);
        }

        var acceptableDelay = null;
        var off = $rootScope.$on('user_connected', function () {
          off();

          if (acceptableDelay) {
            $timeout.cancel(acceptableDelay);
          }

          deferred.resolve(socket);
        }); // if the response does not come quick..let's give up so that users don't get stuck waiting
        // and the process relying on the reconnect() does not get stuck undefinitely.

        acceptableDelay = $timeout(function () {
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
        } // establish connection without passing the token (so that it is not visible in the log)
        // and keep the connection alive


        var connectOptions = _.assign(socketConnectionOptions || {}, {
          'forceNew': true // by default the socket will reconnect after any disconnection error (except if disconnect co
          // default value: https://socket.io/docs/client-api/#new-Manager-url-options
          // reconnectionAttempts: Infinity - number of reconnection attempts before giving up
          // reconnectionDelay:1000 how long to initially wait before attempting a new reconnection. Affected by +/- randomizationFactor, for example the default initial delay will be between 500 to 1500ms.
          // reconnectionDelayMax:5000 maximum amount of time to wait between reconnections. Each attempt increases the reconnection delay by 2x along with a randomization factor.
          // randomizationFactor:0.5 0 <= randomizationFactor <= 1
          // timeout:20000 connection timeout before a connect_error and connect_timeout events are emitted
          // autoConnect:true by setting this false, you have to call manager.open whenever you decide it’s appropriate

        }); // When using long polling the load balancer must be set to you sticky session to establish the socket connection
        // io client would initiate first the connection with long polling then upgrade to websocket.


        if (longPolling !== true) {
          connectOptions.transports = ['websocket'];
        }

        socket = io.connect(connectOptions);
        socket.on('connect', onConnect).on('authenticated', onAuthenticated).on('unauthorized', onUnauthorized).on('logged_out', onLogOut).on('disconnect', onDisconnect);
        socket.on('connect_error', function (reason) {
          // issue during connection
          setConnectionStatus(false, reason);
        }); // ///////////////////////////////////////////

        function onConnect() {
          // Pass the origin if any to handle multi session on a browser.
          setConnectionStatus(false, 'Authenticating'); // the socket is connected, time to pass the auth code or current token to authenticate asap
          // because if it expires, user will have to relog in

          socket.emit('authenticate', {
            token: localStorage.token,
            origin: localStorage.origin || null
          }); // send the jwt
        }

        function onDisconnect(reason) {
          // Reasons:
          // - "ping timeout"    - network issue - define in socketio at 20secs
          // - "transport close" - server closed the socket  (logout will not have time to trigger onDisconnect)
          setConnectionStatus(false, reason);
          $rootScope.$broadcast('user_disconnected'); // after the socket disconnect, socketio will reconnect the server automatically by default.
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

          var payload = service.decodeToken(refreshToken); // the server confirmed that the token is valid...we are good to go

          if (debug) {
            // jti: is the number of times it was refreshed
            console.debug("AUTH(debug): authenticated, received new token (jti:" + payload.jti + "): " + (refreshToken != localStorage.token) + ", currently connected: " + userSession.connected);
          }

          localStorage.token = refreshToken; // if the backend does not receive the acknowlegment due to network error (the token will not be revoked)
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

          userInactivityMonitor.start(function () {
            notifyUserActivityToBackend(socket);
          });
          scheduleRefreshToken(payload);
        }

        function monitorActiveSessionTimeout() {
          if (!activeSessionTimeout) {
            // if the client does not have the proper time, the logout initiated from the client side might be off (too early or too late)
            var remainingActiveSessionTime = service.getRemainingActiveTime();

            if (remainingActiveSessionTime < 0) {
              remainingActiveSessionTime = 5000; // let's give a few seconds, so that developer can check the console
              // and understand that there is an issue with the time
              // anyway the server tracks the time as well and will log out the user at proper time as well

              console.error('AUTH(error): Client machine time might be off');
            }

            activeSessionTimeout = setTimeout(function () {
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
          var sessionRange = null;

          if (userSession.iat !== payload.iat || userSession.exp !== payload.exp) {
            sessionRange = {
              sessionStart: new Date(payload.iat * 1000),
              sessionEnd: new Date(payload.exp * 1000),
              sessionDuration: payload.exp - payload.iat
            };
            console.debug("AUTH(debug): User session started on " + sessionRange.sessionStart + " and will end on " + sessionRange.sessionEnd + " - duration: " + (sessionRange.sessionDuration / 60).toFixed(1) + " min(s)");
          }

          _.assign(userSession, payload, sessionRange);

          return userSession;
        }

        function scheduleRefreshToken(payload) {
          clearNewTokenRequestTimeout(); // To revise later on :
          // --------------------
          // Rare but all tabs might refresh a token at the same time.
          // risk to get kicked out!

          var duration = payload.dur;

          if (debug) {
            console.debug('AUTH(debug): Schedule to request a new token in ' + duration);
          }

          tokenRequestTimeout = $timeout(function () {
            if (debug) {
              console.debug('AUTH(debug): Time to request new token');
            } // re authenticate with the token from the storage since another browser could have modified it.


            if (!localStorage.token) {
              onUnauthorized('Token no longer available');
            }

            socket.emit('authenticate', {
              token: localStorage.token
            }); // Note: If communication crashes right after we emitted and before server sends back the token,
            // when the client reestablishes the connection, it might be able to authenticate if the token is still valid, otherwise we will be sent back to login.
          }, duration * 1000);
        }
      }

      function decodeToken(token) {
        var base64Url = token.split('.')[1];
        var base64 = base64Url.replace('-', '+').replace('_', '/');
        var payload = JSON.parse($window.atob(base64));
        return payload;
      }

      function getRemainingActiveTime() {
        // session has not received any token data yet.
        if (!userSession.exp) {
          return null;
        }

        return userSession.exp * 1000 - Date.now();
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
        notifyListeners('sessionTerminated', userSession); // if the network is disconnected, the redirect will not work.

        setTimeout(function () {
          service.redirect(url);
        }, 1500);
      }

      function redirect(url) {
        $window.location.replace(url || 'badUrl.html');
      }

      function redirectToLogin() {
        var url = window.location.protocol + '//' + window.location.host + loginUrl + '?to=' + encodeURIComponent(window.location.href);
        service.exitToUrl(url);
      }
    }];

    function notifyUserActivityToBackend(socket) {
      var lastNotif = Number(localStorage.lastNu || 0);
      var now = Date.now() / 1000;

      if (now - lastNotif >= 30) {
        localStorage.lastNu = now;
        socket.emit('activity');
      }
    }

    function createInactiveSessionMonitoring() {
      var maxInactiveTimeout = 7 * 24 * 60;
      var monitor = {
        timeoutId: null,
        timeoutInMins: 0,
        started: false,
        onTimeout: null
      }; // as soon as there is a user activity the timeout will be resetted but not more than once every sec.

      var notifyUserActivity = _.throttle(function () {
        debug && console.debug('AUTH(debug): User activity detected');
        resetMonitor();
        monitor.onActivityDetected();
      }, 1000, {
        leading: true,
        trailing: false
      });

      monitor.start = function (onActivityDetected) {
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

      monitor.setTimeoutInMins = function (value) {
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

      monitor.getTimeoutInMins = function () {
        return monitor.timeoutInMins;
      };

      monitor.getRemainingTime = function () {
        var inactiveTime = Date.now() - localStorage.lastActivity;
        return 60000 * monitor.timeoutInMins - inactiveTime;
      };

      function resetMonitor() {
        localStorage.lastActivity = Date.now();
        window.clearTimeout(monitor.timeoutId);

        if (monitor.timeoutInMins !== 0) {
          debug && console.debug("AUTH(debug): User inactivity timeout resetted to " + monitor.timeoutInMins + " mins.");
          monitor.timeoutId = window.setTimeout(setMonitorTimeout, monitor.timeoutInMins * 60000);
        }
      }

      ;

      function setMonitorTimeout() {
        var timeBeforeTimeout = monitor.getRemainingTime();

        if (timeBeforeTimeout <= 0) {
          monitor.onTimeout();
        } else {
          // still need to wait, user was active in another tab
          // This tab must take in consideration the last activity
          debug && console.debug("AUTH(debug): User was active in another tab, wait " + timeBeforeTimeout / 1000 + " secs more before timing out");
          monitor.timeoutId = window.setTimeout(monitor._timeout, timeBeforeTimeout);
        }
      }

      ;
      return monitor;
    }

    function retrieveAuthCodeFromUrlOrTokenFromStorage() {
      // token will alsway come last in the url if any.
      var pos = window.location.href.indexOf('token=');

      if (pos !== -1) {
        var url = window.location.href.substring(0, pos);
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
      var id = type + Date.now();
      var typeListeners = listeners[type];

      if (!typeListeners) {
        typeListeners = listeners[type] = {};
      }

      typeListeners[id] = callback;
      return function () {
        delete typeListeners[id];
      };
    }

    function notifyListeners(type) {
      for (var _len = arguments.length, params = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
        params[_key - 1] = arguments[_key];
      }

      _.forEach(listeners[type], function (callback) {
        return callback.apply(undefined, params);
      });
    }
  }
})();
"use strict";

(function () {
  /**
   * This service allows your application contact the websocket api.
   *
   * It will ensure that the connection is available and user is authenticated before fetching data.
   *
   */
  angular.module('zerv.core').provider('$socketio', socketioProvider);

  function socketioProvider() {
    var _this = this;

    var debug = void 0;
    var defaultMaxFetchAttempts = void 0;
    var defaultFetchTimeoutInSecs = void 0;
    var defaultPostTimeoutInSecs = void 0;
    var transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : {
      serialize: noop,
      deserialize: noop
    };

    function noop(v) {
      return v;
    }

    this.setDebug = function (value) {
      debug = value;
      return this;
    };
    /**
     * Set how many attempts a fetch will happen by default
     *
     * The number of attempts might not be reached during a fetch if the timeout kicks in first
     *
     * @param {Number} value
     */


    this.setDefaultMaxFetchAttempts = function (value) {
      defaultMaxFetchAttempts = value !== 0 ? value : Infinity;
      debug && logDebug('set defaultMaxFetchAttempts to ' + defaultMaxFetchAttempts);
      return _this;
    };
    /**
     * Set the maximum time a fetch can take to complete before timing out
     *
     * Even though the fetch might be attempted mulitiple times meanwhile.
     *
     *
     * @param {Number} value
     */


    this.setDefaultFetchTimeoutInSecs = function (value) {
      defaultFetchTimeoutInSecs = value;
      debug && logDebug('set defaultFetchTimeoutInSecs to ' + defaultFetchTimeoutInSecs);
      return _this;
    };
    /**
     * Set the maximum time a post can take to complete before timing out
     *
     * Even though the fetch might be attempted mulitiple times meanwhile.
     *
     *
     * @param {Number} value
     */


    this.setDefaultPostTimeoutInSecs = function (value) {
      defaultPostTimeoutInSecs = value;
      debug && logDebug('set defaultPostTimeoutInSecs to ' + defaultPostTimeoutInSecs);
      return _this;
    };

    this.getDefaultMaxFetchAttempts = function () {
      return defaultMaxFetchAttempts;
    };

    this.getDefaultFetchMaxTimeout = function () {
      return defaultFetchTimeoutInSecs;
    };

    this.getDefaultPostMaxTimeout = function () {
      return defaultPostTimeoutInSecs;
    };

    this.setDefaultMaxFetchAttempts(3);
    this.setDefaultFetchTimeoutInSecs(120);
    this.setDefaultPostTimeoutInSecs(300);

    this.$get = ["$rootScope", "$q", "$auth", function socketioService($rootScope, $q, $auth) {
      var service = {
        on: on,
        emit: emit,
        logout: $auth.logout,
        fetch: fetch,
        post: post,
        notify: notify,
        _socketEmit: _socketEmit
      };
      return service; // /////////////////

      function on(eventName, callback) {
        $auth.connect().then(function (socket) {
          socket.on(eventName, function () {
            var args = arguments;
            $rootScope.$apply(function () {
              callback.apply(socket, args);
            });
          });
        });
      } // deprecated, use post/notify/fetch


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
       * @param {String} operation
       * @param {Object} data
       * @param {Object} options
       * @property {Number} options.attempts nb of attempts to try to emit, default to defaultMaxFetchAttempts
       * @property {Number} options.timeout maximum time to execute all those attempts before giving up, default to defaultFetchTimeoutInSecs
       * @returns {Promise<Object} data received
       */


      function fetch(operation, data) {
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
        // it is very important to define the timeout
        // fetching lots of data might take time for some api call, timeout shoud be increased
        // after the timeout passes system will retry;
        return service._socketEmit(operation, data, 'fetch', options);
      }
      /**
       * notify is similar to fetch but more meaningful
       * @param {String} operation
       * @param {Object} data
       * @param {Object} options
       * @property {Number} options.attempts nb of attempts to try to emit, default to defaultMaxFetchAttempts
       * @property {Number} options.timeout maximum time to execute all those attempts before giving up, default to defaultFetchTimeoutInSecs
       * @returns {Promise<Object} data received
       */


      function notify(operation, data) {
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
        return service._socketEmit(operation, data, 'notify', options);
      }
      /**
       * post sends data to the server in order to modify data.
       *
       * There is no guarantee that the post made it to the server if it times out
       * Currenlty, this will not retry in case of network failure to avoid posting multiple times the same data.
       *
       * @param {String} operation
       * @param {Object} data
       * @param {Object} options
       * @property {Number} options.attempts nb of attempts to try to emit, default to 1
       * @property {Number} options.timeout maximum time to execute all those attempts before giving up, default to 300secs
       * @returns {Promise<Object} data received
       */


      function post(operation, data) {
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
        var lowerCase = operation.toLowerCase(); // the fetch retries, usually not the post. is the developper using the right function?

        if (_.find(['.get', '.is', 'fetch', 'find'], function (kw) {
          return lowerCase.indexOf(kw) !== -1;
        })) {
          console.warn("IO(warn): " + operation + " seems to be a fetch, but function post is used. Modify operation name or use function fetch.");
        } // By default, there is hard coded timeout and the function tries only once to make sure the post ends at some point.
        // the calling function should deal with the retry as data might have changed between calls.
        // Otherwise, provide the max attempts to the function.


        options = {
          attempts: options.attempts || 1,
          timeout: options.timeout || defaultPostTimeoutInSecs
        };
        return service._socketEmit(operation, data, 'post', options);
      }
      /**
       * This function wraps the level socket emit function which is not re-emitting the data by itself currently.
       *
       * If the emit fails and option.attempts is set, it will retry as soon as the network detected available (with no wait time)
       * A timeout prevents to wait eternally if the network never comes back
       *
       * @param {String} operation
       * @param {Object} data
       * @param {Object} options
       * @property {Number} options.attempts nb of attempts to try to emit, default to defaultMaxFetchAttempts
       * @property {Number} options.timeout maximum time to execute all those attempts before giving up, default to defaultFetchTimeoutInSecs
       * @returns {Promise<Object} data received
       */


      function _socketEmit(operation, data, type) {
        var options = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};
        var serialized = transport.serialize(data);
        var deferred = $q.defer();
        var emitMaxAttempts = options.attempts || defaultMaxFetchAttempts;
        var emitTimeoutInSecs = options.timeout || defaultFetchTimeoutInSecs;
        var listenerOff = void 0;
        var startTime = Date.now();
        var attemptNb = 1;
        var timeoutHandler = startTimeoutMonitoring(emitTimeoutInSecs);
        $auth // make sure socket is connected at least.
        .connect() // if the connection layer could connect, no need to try emit at all.
        // (Or could we rely on the emit timeout instead?)
        .catch(onConnectionError) // otherwise emit
        .then(handleEmitAttempts);
        return deferred.promise.finally(function () {
          clearTimeout(timeoutHandler);

          if (listenerOff) {
            // there is no longer a need to listen for connection, since the promise completed
            listenerOff();
          }
        });

        function startTimeoutMonitoring(emitTimeoutInSecs) {
          if (!_.isNumber(emitTimeoutInSecs)) {
            var result = {
              code: 'EMIT_ERR',
              description: "Failed to emit [" + type + "/" + operation + "] - incorrect timeout setting."
            };
            debug && logDebug("Error on [" + type + "/" + operation + "] ->" + JSON.stringify(result));
            deferred.reject({
              code: result.code,
              description: result.data
            });
          } // if _socketEmit times out, it usually means there is too much slowness (network) or UI or backend processing.
          // ex that can trigger timeout:
          // 1. ui execute socket emit and wait
          // 2. ui executes lots of processing (large loop, or many promises to get executed first)
          // 3. then emit might NOT process the response due to step 2 taking too much time. _socketEmit will timeout.
          // Note:
          // UI should warn the user that there is connectivity issue and should manually retry.
          // but at least the user would understand that the data might not be updated.


          return setTimeout(function () {
            var result = {
              code: 'NO_SERVER_RESPONSE_ERR',
              description: "Failed to emit [" + type + "/" + operation + "] or process response - Network or browser too busy - timed out after " + emitTimeoutInSecs + " secs and " + attemptNb + " attempt(s)"
            };
            debug && logDebug("Error on [" + type + "/" + operation + "] ->" + JSON.stringify(result));
            deferred.reject(result);
          }, emitTimeoutInSecs * 1000);
        }

        function handleEmitAttempts(socket) {
          // socket is supposed to be successfully connected at this point (but it is never a guarantee)
          if (emitMaxAttempts > 1) {
            // if socket disconnects and reconnects during the emit
            // the emit will most likely not make it or acknowledge (Remember -> emit never throws error)
            // On reconnect, let's emit again
            // but we just don't know when connection might come back, socketio is trying in the background.
            // Timeout might kick in at some point to cancel the operation
            listenerOff = $auth.addConnectionListener(function () {
              // system just reconnected
              // let's emit again
              if (emitMaxAttempts >= ++attemptNb) {
                emitData(socket);
              } else {
                var result = {
                  code: 'NO_SERVER_RESPONSE_ERR',
                  description: "Failed to emit to [" + type + "/" + operation + "] or process response - Made " + emitMaxAttempts + " attempt(s)"
                };
                debug && logDebug("Error on [" + type + "/" + operation + "] ->" + JSON.stringify(result));
                deferred.reject(result);
              }
            });
          }

          emitData(socket);
        }

        function onConnectionError(err) {
          var result = {
            code: 'CONNECTION_ERR',
            description: err
          };
          debug && logDebug("Error on  [" + type + "/" + operation + "] ->" + JSON.stringify(result));
          deferred.reject(result);
          return Promise.reject(err);
        }

        function emitData(socket) {
          debug && logDebug("socket emitting compressed data [" + getJsonSize(serialized) + "] to [" + type + "/" + operation + "] - attempt " + attemptNb + "/" + emitMaxAttempts);
          socket.emit('api', operation, serialized, function (serializedResult) {
            clearTimeout(timeoutHandler);
            var dataReceivedIn = Date.now() - startTime;
            debug && console.debug("IO(debug): Received compressed data [" + getJsonSize(serializedResult) + "] from [" + type + "/" + operation + "] in " + dataReceivedIn.toFixed(0) + "ms and " + attemptNb + " attempt(s)");
            var result = transport.deserialize(serializedResult);

            if (result.code) {
              debug && logDebug("Error emitting [" + type + "/" + operation + "] ->" + JSON.stringify(result));
              deferred.reject({
                code: result.code,
                description: result.data
              });
            } else {
              deferred.resolve(result.data);
            }
          });
        }
      }
    }];

    function getJsonSize(obj) {
      if (_.isNil(obj)) {
        return 'none';
      }

      return formatSize(JSON.stringify(obj).length);
    }

    function formatSize(size) {
      return size > 1000000 ? roundNumber(size / 1000000, 3) + 'Mgb' : size > 1000 ? roundNumber(size / 1000, 3) + 'Kb' : roundNumber(size) + 'b';
    }

    function roundNumber(num, n) {
      if (!n) {
        return Math.round(num);
      }

      var d = Math.pow(10, n);
      return Math.round(num * d) / d;
    }

    function logDebug(msg) {
      console.debug('IO(debug): ' + msg);
    }
  }
})();
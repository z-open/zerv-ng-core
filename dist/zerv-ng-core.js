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

    var loginUrl = void 0,
        logoutUrl = void 0,
        debug = void 0,
        reconnectionMaxTime = 15,
        onSessionExpirationCallback = void 0,
        onUnauthorizedCallback = void 0;
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

    this.$get = ["$rootScope", "$location", "$timeout", "$q", "$window", function ($rootScope, $location, $timeout, $q, $window) {
      var socket = void 0;
      var sessionUser = {
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
        redirect: redirect,
        setInactiveSessionTimeoutInMins: userInactivityMonitor.setTimeoutInMins,
        getRemainingInactiveTime: userInactivityMonitor.getRemainingTime,
        addConnectionListener: addConnectionListener,
        addDisconnectionListener: addDisconnectionListener
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
        var deferred = $q.defer(); // The socket might be no longer physically connected
        // but since the PING PONG has not happened yet, it is believed to be connected.

        if (sessionUser.connected) {
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

        if (sessionUser.connected) {
          deferred.resolve(socket);
        }

        var acceptableDelay = void 0;
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
        }

        var tokenRequestTimeout = void 0,
            graceTimeout = void 0; // establish connection without passing the token (so that it is not visible in the log)
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
            origin: localStorage.origin
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

        function onAuthenticated(refreshToken) {
          userInactivityMonitor.start(); // the server confirmed that the token is valid...we are good to go

          if (debug) {
            console.debug('AUTH(debug): authenticated, received new token: ' + (refreshToken != localStorage.token) + ', currently connected: ' + sessionUser.connected);
          }

          localStorage.token = refreshToken; // identify origin for multi session

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
          clearNewTokenRequestTimeout(); // token is no longer available.

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
          var expectancy = payload.dur; // if the network is lost just before the token is automatially refreshed
          // but socketio reconnects before the token expired 
          // a new token will be provided and session is maintained.
          // To revise:
          // ---------- 
          // Currently, each reconnection will return a new token
          // Later on, it might be better the backend returns a new token only when it gets closer to expiration
          // it seems a waste of resources (many token blacklisted by zerv-core when poor connection)

          var duration = expectancy * 50 / 100 | 0;

          if (debug) {
            console.debug('AUTH(debug): Schedule to request a new token in ' + duration + ' seconds (token duration:' + expectancy + ')');
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

            var tokenToRefresh = localStorage.token; // this is the amount of time to retrieve the new token.

            graceTimeout = $timeout(function () {
              if (tokenToRefresh === localStorage.token) {
                // The user session is ended if there is no valid toke
                onUnauthorized('session_expired');
              }
            }, (expectancy - duration) * 1000);
          }, duration * 1000);
        }
      }

      function redirect(url) {
        $window.location.replace(url || 'badUrl.html');
      }

      function redirectToLogin() {
        var url = window.location.protocol + '//' + window.location.host + loginUrl + '?to=' + encodeURIComponent(window.location.href);
        service.redirect(url);
      }
    }];

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
      }, 1000, {
        leading: true,
        trailing: false
      });

      monitor.start = function () {
        if (!monitor.started) {
          monitor.started = true;
          document.addEventListener("mousemove", notifyUserActivity, false);
          document.addEventListener("mousedown", notifyUserActivity, false);
          document.addEventListener("keypress", notifyUserActivity, false);
          document.addEventListener("touchmove", notifyUserActivity, false);
          resetMonitor();
        }
      };

      monitor.setTimeoutInMins = function (value) {
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

      monitor.getRemainingTime = function () {
        var inactiveTime = Date.now() - localStorage.lastActivity;
        return 60000 * monitor.timeoutInMins - inactiveTime;
      };

      function resetMonitor() {
        localStorage.lastActivity = Date.now();
        window.clearTimeout(monitor.timeoutId);

        if (monitor.timeoutInMins !== 0) {
          debug && console.debug('AUTH(debug): User inactivity timeout resetted');
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
          debug && console.debug("User was active in another tab, wait " + timeBeforeTimeout / 1000 + " secs more before timing out");
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
    var debug = void 0;
    var defaultMaxAttempts = 3;
    var defaultTimeout = 30;
    var transport = window.ZJSONBIN && !window.ZJSONBIN.disabled ? window.ZJSONBIN : {
      serialize: noop,
      deserialize: noop
    };

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
      }; // /////////////////

      function on(eventName, callback) {
        $auth.connect().then(function (socket) {
          socket.on(eventName, function () {
            var args = arguments;
            $rootScope.$apply(function () {
              callback.apply(socket, args);
            });
          });
        });
      } // deprecated, use post/notify


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
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

        if (debug) {
          console.debug('IO(debug): Fetching ' + operation + '...');
        } // it is very important to define the timeout
        // fetching lots of data might take time for some api call, timeout shoud be increased
        // after the timeout passes system will retry;


        return socketEmit(operation, data, options);
      }
      /**
       * notify is similar to fetch but more meaningful
       */


      function notify(operation, data) {
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

        if (debug) {
          console.debug('IO(debug): Notifying ' + operation + '...');
        }

        return socketEmit(operation, data, options);
      }
      /**
       * post sends data to the server in order to modify data.
       * 
       * There is no guarantee that the post made it to the server if it times out
       * Currenlty, this will not retry in case of network failure to avoid posting multiple times the same data.
       * 
       */


      function post(operation, data) {
        if (debug) {
          console.debug('IO(debug): Posting ' + operation + '...');
        } // there is no timeout
        // the calling function should deal with the retry
        // if the operation never returns.


        return socketEmit(operation, data, {
          attempts: 1,
          timeout: Infinity
        });
      }
      /**
       * This function wraps the level socket emit function which is not re-emitting the data by itself currently.
       * 
       * If the emit fails and option.attempts is set, it will retry as soon as the network detected available (with no wait time)
       * A timeout prevents to wait eternally if the network never comes back
       * 
       * @param {String} operation 
       * @param {Object} data 
       * @param {Option} options 
       * 
       * @returns {Promise} the result from the api call
       */


      function socketEmit(operation, data) {
        var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
        var serialized = transport.serialize(data);
        var deferred = $q.defer();
        var attemptNb = 1;
        var maxAttempt = options.attempts || defaultMaxAttempts;
        var timeoutInSecs = 240 || options.timeout || defaultTimeout;
        var timeoutHandler = void 0;
        var listener = void 0; // system is believed to be connected

        if (timeoutInSecs !== Infinity && _.isNumber(timeoutInSecs)) {
          // if times out, it means there is too much slowness or processing and it might be better UX to give up and release resources
          // ex that can trigger timeout:
          // 1. ui execute socket emit and wait
          // 2. ui executes lots of processing (large loop, or many promises to get execute first)
          // 3. then emit might NOT process the response due to step 2 took too much time. socketEmit will timeout
          // and warn the user that there is connectivity issue and should manually retry.
          // but at least the user would understand that the data might not be updated.
          timeoutHandler = setTimeout(function () {
            var result = {
              code: 'EMIT_TIMEOUT',
              description: "Failed to emit [" + operation + "] or process response - Network or browser too busy - timed out after " + timeoutInSecs + " and " + attemptNb + " attempt(s)"
            };
            debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
            deferred.reject({
              code: result.code,
              description: result.data
            });
          }, timeoutInSecs * 1000);
        }

        var startTime = Date.now();
        $auth.connect().then(function (socket) {
          // socket is successfully connected
          if (maxAttempt > 1) {
            // if socket disconnects and reconnects during the emit
            // the emit will most likely not make it and acknowledge (emit never throws error)
            // On reconnect, let's emit again
            // but we just don't know when connection might come back, socketio is trying in the background.
            // Timeout might kick in at some point to cancel the operation
            listener = $auth.addConnectionListener(function () {
              // system just reconnected
              // let's emit again
              if (maxAttempt > ++attemptNb) {
                emit(socket);
              } else {
                var result = {
                  code: 'EMIT_RETRY_ERR',
                  description: "Failed to emit to [" + operation + "] or process response - Made " + attemptNb + " attempt(s)"
                };
                debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
                deferred.reject({
                  code: result.code,
                  description: result.data
                });
              }
            });
          }

          emit(socket);
        }).catch(function (err) {
          // if the connection layer could connect, no need to try emit.
          clearTimeout(timeoutHandler);
          var result = {
            code: 'CONNECTION_ERR',
            description: err
          };
          debug && console.debug('IO(debug): Error on [' + operation + '] ->' + JSON.stringify(result));
          deferred.reject(result);
        });
        return deferred.promise.finally(function () {
          if (listener) {
            // there is no longer a need to listen for connection, since the promise completed
            listener();
          }
        });

        function emit(socket) {
          debug && console.debug("IO(debug): socket emitting compressed data [" + getJsonSize(serialized) + "] to [" + operation + "] - attempt " + attemptNb + "/" + maxAttempt);
          socket.emit('api', operation, serialized, function (serializedResult) {
            clearTimeout(timeoutHandler);
            var dataReceivedIn = Date.now() - startTime;
            debug && console.debug("IO(debug): Received compressed data [" + getJsonSize(serializedResult) + "] from [" + operation + "] in " + dataReceivedIn.toFixed(0) + "ms and " + attemptNb + " attempt(s)");
            var result = transport.deserialize(serializedResult);

            if (result.code) {
              debug && console.debug('IO(debug): Error emitting [' + operation + '] ->' + JSON.stringify(result));
              deferred.reject({
                code: result.code,
                description: result.data
              });
            } else {
              deferred.resolve(result.data);
            }
          });
        }
      } // function socketEmit2(operation, data, options = {}) {
      //     const serialized = transport.serialize(data);
      //     return $auth.connect()
      //         .then(onConnectionSuccess, onConnectionError);
      //     function onConnectionSuccess(socket) {
      //         const deferred = $q.defer();
      //         const maxAttempt = options.attempts || defaultMaxAttempts;
      //         const timeoutInSecs = options.timeout || defaultTimeout;
      //         // the connection is supposed to be established
      //         // if not, during the process of the emit, it will fail
      //         // the emit will never receive the ack
      //         // data might have arrived, not sure
      //         // this could be stamped
      //         // and retry anyway
      //         emit(1);
      //         function emit(attemptNb) {
      //             let timeoutHandler;
      //             if (timeoutInSecs !== Infinity && _.isNumber(timeoutInSecs))
      //                 timeoutHandler = setTimeout(() => {
      //                 if (maxAttempt > attemptNb) {
      //                     // most likely the connection was lost right before emit..
      //                     socket.connect();
      //                     emit(++attemptNb);
      //                 } else {
      //                     const result = {code: 'EMIT_TIMEOUT', description: 'Failed to emit '+ operation};
      //                     debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
      //                     deferred.reject({code: result.code, description: result.data});
      //                 }
      //             }, timeoutInSecs * 1000);
      //             debug && console.debug(`IO(debug): socket emitting ${operation} - attempt ${attemptNb}/${maxAttempt}`);
      //             socket.emit('api', operation, serialized, function(serializedResult) {
      //                 clearTimeout(timeoutHandler);
      //                 if (debug) {
      //                     console.debug('IO(debug): ACKed socketEmit ' + operation);
      //                 }
      //                 const result = transport.deserialize(serializedResult);
      //                 if (result.code) {
      //                     debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
      //                     deferred.reject({code: result.code, description: result.data});
      //                 } else {
      //                     deferred.resolve(result.data);
      //                 }
      //             });
      //         }
      //         return deferred.promise;
      //     }
      //     function onConnectionError(err) {
      //         const result = {code: 'CONNECTION_ERR', description: err};
      //         debug && console.debug('IO(debug): Error on ' + operation + ' ->' + JSON.stringify(result));
      //         return $q.reject(result);
      //     }
      // }

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
  }
})();
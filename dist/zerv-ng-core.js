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
    .module('zerv.core')
    .provider('$socketio', socketioProvider);

function socketioProvider() {
    var debug;
    var transport = window.ZJSONBIN || { serialize: noop, deserialize: noop };
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
            var serialized = transport.serialize(data);

            return $auth.connect()
                .then(onConnectionSuccess, onConnectionError)
                ;// .catch(onConnectionError);

            ////////////
            function onConnectionSuccess(socket) {
                var deferred = $q.defer();
                socket.emit('api', operation, serialized, function (serializedResult) {
                    const result = transport.deserialize(serializedResult);

                    if (result.code) {
                        debug && console.debug('Error on ' + operation + ' ->' + JSON.stringify(result));
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInplcnYtbmctY29yZS5qcyIsInNvY2tldC5tb2R1bGUuanMiLCJzZXJ2aWNlcy9hdXRoLnNlcnZpY2UuanMiLCJzZXJ2aWNlcy9zb2NrZXRpby5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBLFFBQUEsT0FBQSxhQUFBOzs7QURNQSxDQUFDLFdBQVc7QUFDWjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FFYUE7S0FDQSxPQUFBOztLQUVBLFFBQUEseUJBQUEsVUFBQSxPQUFBO1FBQ0EsT0FBQSxNQUFBOztLQUVBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7O0lBRUEsSUFBQSxVQUFBLFdBQUEsT0FBQSxzQkFBQTs7SUFFQSxLQUFBLFdBQUEsVUFBQSxPQUFBO1FBQ0EsUUFBQTs7O0lBR0EsS0FBQSxjQUFBLFVBQUEsT0FBQTtRQUNBLFdBQUE7OztJQUdBLEtBQUEsZUFBQSxVQUFBLE9BQUE7UUFDQSxZQUFBOzs7SUFHQSxLQUFBLCtCQUFBLFVBQUEsT0FBQTtRQUNBLHNCQUFBLFFBQUE7OztJQUdBLEtBQUEsZ0VBQUEsVUFBQSxZQUFBLFdBQUEsVUFBQSxJQUFBLFNBQUE7O1FBRUEsSUFBQTtRQUNBLElBQUEsWUFBQTtRQUNBLElBQUEsY0FBQSxFQUFBLFdBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7Ozs7O2VBS0E7WUFDQSxhQUFBLFFBQUE7O1FBRUEsT0FBQTtZQUNBLFNBQUE7WUFDQSxRQUFBO1lBQ0EsZ0JBQUE7Ozs7OztRQU1BLFNBQUEsaUJBQUE7O1lBRUEsT0FBQTs7Ozs7OztRQU9BLFNBQUEsVUFBQTtZQUNBLElBQUEsQ0FBQSxRQUFBO2dCQUNBOztZQUVBLE9BQUE7OztRQUdBLFNBQUEsU0FBQTs7WUFFQSxJQUFBLFFBQUE7Z0JBQ0EsT0FBQSxLQUFBLFVBQUE7Ozs7UUFJQSxTQUFBLHdCQUFBO1lBQ0EsSUFBQSxXQUFBLEdBQUE7WUFDQSxJQUFBLFlBQUEsV0FBQTtnQkFDQSxTQUFB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TUFBQTtZQUNBLElBQUEsT0FBQSxFQUFBLFFBQUEsTUFBQSxhQUFBLFlBQUE7WUFDQSxPQUFBLFdBQUEsV0FBQTs7O1FBR0EsU0FBQSxXQUFBLFdBQUEsTUFBQTtZQUNBLElBQUEsYUFBQSxVQUFBLFVBQUE7O1lBRUEsT0FBQSxNQUFBO2lCQUNBLEtBQUEscUJBQUE7Ozs7WUFJQSxTQUFBLG9CQUFBLFFBQUE7Z0JBQ0EsSUFBQSxXQUFBLEdBQUE7Z0JBQ0EsT0FBQSxLQUFBLE9BQUEsV0FBQSxZQUFBLFVBQUEsa0JBQUE7b0JBQ0EsTUFBQSxTQUFBLFVBQUEsWUFBQTs7b0JBRUEsSUFBQSxPQUFBLE1BQUE7d0JBQ0EsU0FBQSxRQUFBLE1BQUEsY0FBQSxZQUFBLFFBQUEsS0FBQSxVQUFBO3dCQUNBLFNBQUEsT0FBQSxFQUFBLE1BQUEsT0FBQSxNQUFBLGFBQUEsT0FBQTs7eUJBRUE7d0JBQ0EsU0FBQSxRQUFBLE9BQUE7OztnQkFHQSxPQUFBLFNBQUE7OztZQUdBLFNBQUEsa0JBQUEsS0FBQTtnQkFDQSxPQUFBLEdBQUEsT0FBQSxFQUFBLE1BQUEsa0JBQUEsYUFBQTs7Ozs7OztBSDBSQSIsImZpbGUiOiJ6ZXJ2LW5nLWNvcmUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhci5tb2R1bGUoJ3plcnYuY29yZScsIFtdKTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHByb3ZpZGVyIGhhbmRsZXMgdGhlIGhhbmRzaGFrZSB0byBhdXRoZW50aWNhdGUgYSB1c2VyIGFuZCBtYWludGFpbiBhIHNlY3VyZSB3ZWIgc29ja2V0IGNvbm5lY3Rpb24gdmlhIHRva2Vucy5cbiAqIEl0IGFsc28gc2V0cyB0aGUgbG9naW4gYW5kIGxvZ291dCB1cmwgcGFydGljaXBhdGluZyBpbiB0aGUgYXV0aGVudGljYXRpb24uXG4gKiBcbiAqIFxuICogdXNhZ2UgZXhhbXBsZXM6XG4gKiBcbiAqIEluIHRoZSBjb25maWcgb2YgdGhlIGFwcCBtb2R1bGU6XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9naW5VcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9nb3V0VXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MoMTUpO1xuICogVGhpcyBkZWZpbmVzIGhvdyBtdWNoIHRpbWUgd2UgY2FuIHdhaXQgdG8gZXN0YWJsaXNoIGEgc3VjY2Vzc3VsIGNvbm5lY3Rpb24gYmVmb3JlIHJlamVjdGluZyB0aGUgY29ubmVjdGlvbiAoc29ja2V0U2VydmljZS5jb25uZWN0SU8pIHdpdGggYSB0aW1lb3V0LiBieSBkZWZhdWx0LCBpdCB3aWxsIHRyeSBmb3IgMTUgc2Vjb25kcyB0byBnZXQgYSBjb25uZWN0aW9uIGFuZCB0aGVuIGdpdmUgdXBcbiAqICBcbiAqIEJlZm9yZSBhbnkgc29ja2V0IHVzZSBpbiB5b3VyIHNlcnZpY2VzIG9yIHJlc29sdmUgYmxvY2tzLCBjb25uZWN0KCkgbWFrZXMgc3VyZSB0aGF0IHdlIGhhdmUgYW4gZXN0YWJsaXNoZWQgYXV0aGVudGljYXRlZCBjb25uZWN0aW9uIGJ5IHVzaW5nIHRoZSBmb2xsb3dpbmc6XG4gKiBzb2NrZXRTZXJ2aWNlLmNvbm5lY3QoKS50aGVuKFxuICogZnVuY3Rpb24oc29ja2V0KXsgLi4uIHNvY2tldC5lbWl0KCkuLiB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHsuLi59KVxuICogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLy8gY29udmVuaWVudCBzZXJ2aWNlIHJldHVybmluZyBzZXNzaW9uVXNlclxuICAgIC5mYWN0b3J5KCdzZXNzaW9uVXNlcicsIGZ1bmN0aW9uICgkYXV0aCkge1xuICAgICAgICByZXR1cm4gJGF1dGguZ2V0U2Vzc2lvblVzZXIoKTtcbiAgICB9KVxuICAgIC5wcm92aWRlcignJGF1dGgnLCBhdXRoUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBhdXRoUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgbG9naW5VcmwsIGxvZ291dFVybCwgZGVidWcsIHJlY29ubmVjdGlvbk1heFRpbWUgPSAxNTtcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dpblVybCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBsb2dpblVybCA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ291dFVybCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBsb2dvdXRVcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHJlY29ubmVjdGlvbk1heFRpbWUgPSB2YWx1ZSAqIDEwMDA7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uICgkcm9vdFNjb3BlLCAkbG9jYXRpb24sICR0aW1lb3V0LCAkcSwgJHdpbmRvdykge1xuXG4gICAgICAgIHZhciBzb2NrZXQ7XG4gICAgICAgIHZhciB1c2VyVG9rZW4gPSByZXRyaWV2ZVRva2VuKCk7XG4gICAgICAgIHZhciBzZXNzaW9uVXNlciA9IHsgY29ubmVjdGVkOiBmYWxzZSB9O1xuXG4gICAgICAgIGlmICghdXNlclRva2VuKSB7XG4gICAgICAgICAgICAvLyBAVE9ETzogdGhpcyByaWdodCB3YXkgdG8gcmVkaXJlY3QgaWYgd2UgaGF2ZSBubyB0b2tlbiB3aGVuIHdlIHJlZnJlc2ggb3IgaGl0IHRoZSBhcHAuXG4gICAgICAgICAgICAvLyAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IHdvdWxkIHByZXZlbnQgbW9zdCB1bml0IHRlc3RzIGZyb20gcnVubmluZyBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIHRpZ2hseSBjb3VwbGVkIHdpdGggYWxsIHVuaXQgdGVzdHMgKGRlcGVuZHMgb24gaXQpYXQgdGhpcyB0aW1lIDpcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gdXNlclRva2VuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0OiBjb25uZWN0LFxuICAgICAgICAgICAgbG9nb3V0OiBsb2dvdXQsXG4gICAgICAgICAgICBnZXRTZXNzaW9uVXNlcjogZ2V0U2Vzc2lvblVzZXJcbiAgICAgICAgfTtcblxuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZXNzaW9uVXNlcigpIHtcbiAgICAgICAgICAgIC8vIHRoZSBvYmplY3Qgd2lsbCBoYXZlIHRoZSB1c2VyIGluZm9ybWF0aW9uIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuIE90aGVyd2lzZSBpdHMgY29ubmVjdGlvbiBwcm9wZXJ0eSB3aWxsIGJlIGZhbHNlOyBcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uVXNlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSBcbiAgICAgICAgICogdGhlIHN1Y2Nlc3MgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHNvY2tldCBhcyBhIHBhcmFtZXRlclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY29ubmVjdCgpIHtcbiAgICAgICAgICAgIGlmICghc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0dXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxvZ291dCgpIHtcbiAgICAgICAgICAgIC8vIGNvbm5lY3Rpb24gY291bGQgYmUgbG9zdCBkdXJpbmcgbG9nb3V0Li5zbyBpdCBjb3VsZCBtZWFuIHdlIGhhdmUgbm90IGxvZ291dCBvbiBzZXJ2ZXIgc2lkZS5cbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnbG9nb3V0JywgdXNlclRva2VuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldEZvclZhbGlkQ29ubmVjdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBiZWluZyB0aGUgc2NlbmUsIHNvY2tldC5pbyBpcyB0cnlpbmcgdG8gcmVjb25uZWN0IGFuZCBhdXRoZW50aWNhdGUgaWYgdGhlIGNvbm5lY3Rpb24gd2FzIGxvc3Q7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0KCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVVNFUl9OT1RfQ09OTkVDVEVEJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlY29ubmVjdCgpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvL0BUT0RPIFRPIFRISU5LIEFCT1VUOiwgaWYgdGhlIHNvY2tldCBpcyBjb25uZWN0aW5nIGFscmVhZHksIG1lYW5zIHRoYXQgYSBjb25uZWN0IHdhcyBjYWxsZWQgYWxyZWFkeSBieSBhbm90aGVyIGFzeW5jIGNhbGwsIHNvIGp1c3Qgd2FpdCBmb3IgdXNlcl9jb25uZWN0ZWRcblxuXG5cbiAgICAgICAgICAgIC8vIGlmIHRoZSByZXNwb25zZSBkb2VzIG5vdCBjb21lIHF1aWNrLi5sZXQncyBnaXZlIHVwIHNvIHdlIGRvbid0IGdldCBzdHVjayB3YWl0aW5nXG4gICAgICAgICAgICAvLyBAVE9ETzpvdGhlciB3YXkgaXMgdG8gd2F0Y2ggZm9yIGEgY29ubmVjdGlvbiBlcnJvci4uLlxuICAgICAgICAgICAgdmFyIGFjY2VwdGFibGVEZWxheTtcbiAgICAgICAgICAgIHZhciBvZmYgPSAkcm9vdFNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKGFjY2VwdGFibGVEZWxheSkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwoYWNjZXB0YWJsZURlbGF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFjY2VwdGFibGVEZWxheSA9ICR0aW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH0sIHJlY29ubmVjdGlvbk1heFRpbWUpO1xuXG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwKCkge1xuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBjYWxsZWQuLi5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgdG9rZW5WYWxpZGl0eVRpbWVvdXQ7XG4gICAgICAgICAgICAvLyBlc3RhYmxpc2ggY29ubmVjdGlvbiB3aXRob3V0IHBhc3NpbmcgdGhlIHRva2VuIChzbyB0aGF0IGl0IGlzIG5vdCB2aXNpYmxlIGluIHRoZSBsb2cpXG4gICAgICAgICAgICBzb2NrZXQgPSBpby5jb25uZWN0KHtcbiAgICAgICAgICAgICAgICAnZm9yY2VOZXcnOiB0cnVlLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdCcsIG9uQ29ubmVjdClcbiAgICAgICAgICAgICAgICAub24oJ2F1dGhlbnRpY2F0ZWQnLCBvbkF1dGhlbnRpY2F0ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCd1bmF1dGhvcml6ZWQnLCBvblVuYXV0aG9yaXplZClcbiAgICAgICAgICAgICAgICAub24oJ2xvZ2dlZF9vdXQnLCBvbkxvZ091dClcbiAgICAgICAgICAgICAgICAub24oJ2Rpc2Nvbm5lY3QnLCBvbkRpc2Nvbm5lY3QpO1xuXG4gICAgICAgICAgICAvLyBUT0RPOiB0aGlzIGZvbGxvd293aW5nIGV2ZW50IGlzIHN0aWxsIHVzZWQuPz8/Li4uLlxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0X2Vycm9yJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNvY2tldCBpcyBjb25uZWN0ZWQsIHRpbWUgdG8gcGFzcyB0aGUgdG9rZW4gdG8gYXV0aGVudGljYXRlIGFzYXBcbiAgICAgICAgICAgICAgICAvLyBiZWNhdXNlIHRoZSB0b2tlbiBpcyBhYm91dCB0byBleHBpcmUuLi5pZiBpdCBleHBpcmVzIHdlIHdpbGwgaGF2ZSB0byByZWxvZyBpblxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7IHRva2VuOiB1c2VyVG9rZW4gfSk7IC8vIHNlbmQgdGhlIGp3dFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkRpc2Nvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1Nlc3Npb24gZGlzY29ubmVjdGVkJyk7IH1cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRicm9hZGNhc3QoJ3VzZXJfZGlzY29ubmVjdGVkJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQXV0aGVudGljYXRlZChyZWZyZXNoVG9rZW4pIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzZXJ2ZXIgY29uZmlybWVkIHRoYXQgdGhlIHRva2VuIGlzIHZhbGlkLi4ud2UgYXJlIGdvb2QgdG8gZ29cbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnYXV0aGVudGljYXRlZCwgcmVjZWl2ZWQgbmV3IHRva2VuOiAnICsgKHJlZnJlc2hUb2tlbiAhPSB1c2VyVG9rZW4pKTsgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgc2V0TG9naW5Vc2VyKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyh0cnVlKTtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Nvbm5lY3RlZCcsc2Vzc2lvblVzZXIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkxvZ091dCgpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIC8vIHRva2VuIGlzIG5vIGxvbmdlciBhdmFpbGFibGUuXG4gICAgICAgICAgICAgICAgZGVsZXRlIGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICByZWRpcmVjdChsb2dvdXRVcmwgfHwgbG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVuYXV0aG9yaXplZChtc2cpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCd1bmF1dGhvcml6ZWQ6ICcgKyBKU09OLnN0cmluZ2lmeShtc2cuZGF0YSkpOyB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRDb25uZWN0aW9uU3RhdHVzKGNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIHNlc3Npb25Vc2VyLmNvbm5lY3RlZCA9IGNvbm5lY3RlZDtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUuZGVidWcoXCJDb25uZWN0aW9uIHN0YXR1czpcIiArIEpTT04uc3RyaW5naWZ5KHNlc3Npb25Vc2VyKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldExvZ2luVXNlcih0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5hc3NpZ24oc2Vzc2lvblVzZXIscGF5bG9hZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNsZWFyVG9rZW5UaW1lb3V0KCkge1xuICAgICAgICAgICAgICAgIGlmICh0b2tlblZhbGlkaXR5VGltZW91dCkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwodG9rZW5WYWxpZGl0eVRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVjb2RlKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NFVybCA9IHRva2VuLnNwbGl0KCcuJylbMV07XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NCA9IGJhc2U2NFVybC5yZXBsYWNlKCctJywgJysnKS5yZXBsYWNlKCdfJywgJy8nKTtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IEpTT04ucGFyc2UoJHdpbmRvdy5hdG9iKGJhc2U2NCkpO1xuICAgICAgICAgICAgICAgIHJldHVybiBwYXlsb2FkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgLy8gcmVxdWVzdCBhIGxpdHRsZSBiZWZvcmUuLi5cbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbiwgeyBjb21wbGV0ZTogZmFsc2UgfSk7XG5cbiAgICAgICAgICAgICAgICB2YXIgaW5pdGlhbCA9IHBheWxvYWQuZHVyO1xuXG4gICAgICAgICAgICAgICAgdmFyIGR1cmF0aW9uID0gKGluaXRpYWwgKiA5MCAvIDEwMCkgfCAwO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdTY2hlZHVsZSB0byByZXF1ZXN0IGEgbmV3IHRva2VuIGluICcgKyBkdXJhdGlvbiArICcgc2Vjb25kcyAodG9rZW4gZHVyYXRpb246JyArIGluaXRpYWwgKyAnKScpOyB9XG4gICAgICAgICAgICAgICAgdG9rZW5WYWxpZGl0eVRpbWVvdXQgPSAkdGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdUaW1lIHRvIHJlcXVlc3QgbmV3IHRva2VuICcgKyBpbml0aWFsKTsgfVxuICAgICAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywgeyB0b2tlbjogdG9rZW4gfSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vdGU6IElmIGNvbW11bmljYXRpb24gY3Jhc2hlcyByaWdodCBhZnRlciB3ZSBlbWl0dGVkIGFuZCB3aGVuIHNlcnZlcnMgaXMgc2VuZGluZyBiYWNrIHRoZSB0b2tlbixcbiAgICAgICAgICAgICAgICAgICAgLy8gd2hlbiB0aGUgY2xpZW50IHJlZXN0YWJsaXNoZXMgdGhlIGNvbm5lY3Rpb24sIHdlIHdvdWxkIGhhdmUgdG8gbG9naW4gYmVjYXVzZSB0aGUgcHJldmlvdXMgdG9rZW4gd291bGQgYmUgaW52YWxpZGF0ZWQuXG4gICAgICAgICAgICAgICAgfSwgZHVyYXRpb24gKiAxMDAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJldHJpZXZlVG9rZW4oKSB7XG4gICAgICAgICAgICB2YXIgdXNlclRva2VuID0gJGxvY2F0aW9uLnNlYXJjaCgpLnRva2VuO1xuICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdVc2luZyB0b2tlbiBwYXNzZWQgZHVyaW5nIHJlZGlyZWN0aW9uOiAnICsgdXNlclRva2VuKTsgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnVXNpbmcgVG9rZW4gaW4gbG9jYWwgc3RvcmFnZTogJyArIHVzZXJUb2tlbik7IH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOIHx8IHsgc2VyaWFsaXplOiBub29wLCBkZXNlcmlhbGl6ZTogbm9vcCB9O1xuICAgIGZ1bmN0aW9uIG5vb3Aodikge1xuICAgICAgICByZXR1cm4gdjtcbiAgICB9XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHNvY2tldGlvU2VydmljZSgkcm9vdFNjb3BlLCAkcSwgJGF1dGgpIHtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb246IG9uLFxuICAgICAgICAgICAgZW1pdDogZW1pdCxcbiAgICAgICAgICAgIGxvZ291dDogJGF1dGgubG9nb3V0LFxuICAgICAgICAgICAgZmV0Y2g6IGZldGNoLFxuICAgICAgICAgICAgcG9zdDogcG9zdCxcbiAgICAgICAgICAgIG5vdGlmeTogbm90aWZ5XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudE5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0Lm9uKGV2ZW50TmFtZSwgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBkZXByZWNhdGVkLCB1c2UgcG9zdC9ub3RpZnlcbiAgICAgICAgZnVuY3Rpb24gZW1pdChldmVudE5hbWUsIGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoZXZlbnROYW1lLCBkYXRhLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZldGNoIGRhdGEgdGhlIHdheSB3ZSBjYWxsIGFuIGFwaSBcbiAgICAgICAgICogaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8yMDY4NTIwOC93ZWJzb2NrZXQtdHJhbnNwb3J0LXJlbGlhYmlsaXR5LXNvY2tldC1pby1kYXRhLWxvc3MtZHVyaW5nLXJlY29ubmVjdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGZldGNoKG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ0ZldGNoaW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBub3RpZnkgaXMgc2ltaWxhciB0byBmZXRjaCBidXQgbW9yZSBtZWFuaW5nZnVsXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBub3RpZnkob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnTm90aWZ5aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBwb3N0IHNlbmRzIGRhdGEgdG8gdGhlIHNlcnZlci5cbiAgICAgICAgICogaWYgZGF0YSB3YXMgYWxyZWFkeSBzdWJtaXR0ZWQsIGl0IHdvdWxkIGp1c3QgcmV0dXJuIC0gd2hpY2ggY291bGQgaGFwcGVuIHdoZW4gaGFuZGxpbmcgZGlzY29ubmVjdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBwb3N0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1Bvc3RpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTsgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICB2YXIgc2VyaWFsaXplZCA9IHRyYW5zcG9ydC5zZXJpYWxpemUoZGF0YSk7XG5cbiAgICAgICAgICAgIHJldHVybiAkYXV0aC5jb25uZWN0KClcbiAgICAgICAgICAgICAgICAudGhlbihvbkNvbm5lY3Rpb25TdWNjZXNzLCBvbkNvbm5lY3Rpb25FcnJvcilcbiAgICAgICAgICAgICAgICA7Ly8gLmNhdGNoKG9uQ29ubmVjdGlvbkVycm9yKTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25TdWNjZXNzKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2FwaScsIG9wZXJhdGlvbiwgc2VyaWFsaXplZCwgZnVuY3Rpb24gKHNlcmlhbGl6ZWRSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gdHJhbnNwb3J0LmRlc2VyaWFsaXplKHNlcmlhbGl6ZWRSZXN1bHQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVidWcgJiYgY29uc29sZS5kZWJ1ZygnRXJyb3Igb24gJyArIG9wZXJhdGlvbiArICcgLT4nICsgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoeyBjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHQuZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uRXJyb3IoZXJyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICRxLnJlamVjdCh7IGNvZGU6ICdDT05ORUNUSU9OX0VSUicsIGRlc2NyaXB0aW9uOiBlcnIgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG59KCkpO1xuXG4iLCJhbmd1bGFyLm1vZHVsZSgnemVydi5jb3JlJywgW10pO1xuIiwiXG4vKiogXG4gKiBUaGlzIHByb3ZpZGVyIGhhbmRsZXMgdGhlIGhhbmRzaGFrZSB0byBhdXRoZW50aWNhdGUgYSB1c2VyIGFuZCBtYWludGFpbiBhIHNlY3VyZSB3ZWIgc29ja2V0IGNvbm5lY3Rpb24gdmlhIHRva2Vucy5cbiAqIEl0IGFsc28gc2V0cyB0aGUgbG9naW4gYW5kIGxvZ291dCB1cmwgcGFydGljaXBhdGluZyBpbiB0aGUgYXV0aGVudGljYXRpb24uXG4gKiBcbiAqIFxuICogdXNhZ2UgZXhhbXBsZXM6XG4gKiBcbiAqIEluIHRoZSBjb25maWcgb2YgdGhlIGFwcCBtb2R1bGU6XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9naW5VcmwoJy9hY2Nlc3MjL2xvZ2luJyk7XG4gKiBzb2NrZXRTZXJ2aWNlUHJvdmlkZXIuc2V0TG9nb3V0VXJsKCcvYWNjZXNzIy9sb2dpbicpO1xuICogc29ja2V0U2VydmljZVByb3ZpZGVyLnNldFJlY29ubmVjdGlvbk1heFRpbWVJblNlY3MoMTUpO1xuICogVGhpcyBkZWZpbmVzIGhvdyBtdWNoIHRpbWUgd2UgY2FuIHdhaXQgdG8gZXN0YWJsaXNoIGEgc3VjY2Vzc3VsIGNvbm5lY3Rpb24gYmVmb3JlIHJlamVjdGluZyB0aGUgY29ubmVjdGlvbiAoc29ja2V0U2VydmljZS5jb25uZWN0SU8pIHdpdGggYSB0aW1lb3V0LiBieSBkZWZhdWx0LCBpdCB3aWxsIHRyeSBmb3IgMTUgc2Vjb25kcyB0byBnZXQgYSBjb25uZWN0aW9uIGFuZCB0aGVuIGdpdmUgdXBcbiAqICBcbiAqIEJlZm9yZSBhbnkgc29ja2V0IHVzZSBpbiB5b3VyIHNlcnZpY2VzIG9yIHJlc29sdmUgYmxvY2tzLCBjb25uZWN0KCkgbWFrZXMgc3VyZSB0aGF0IHdlIGhhdmUgYW4gZXN0YWJsaXNoZWQgYXV0aGVudGljYXRlZCBjb25uZWN0aW9uIGJ5IHVzaW5nIHRoZSBmb2xsb3dpbmc6XG4gKiBzb2NrZXRTZXJ2aWNlLmNvbm5lY3QoKS50aGVuKFxuICogZnVuY3Rpb24oc29ja2V0KXsgLi4uIHNvY2tldC5lbWl0KCkuLiB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHsuLi59KVxuICogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3plcnYuY29yZScpXG4gICAgLy8gY29udmVuaWVudCBzZXJ2aWNlIHJldHVybmluZyBzZXNzaW9uVXNlclxuICAgIC5mYWN0b3J5KCdzZXNzaW9uVXNlcicsIGZ1bmN0aW9uICgkYXV0aCkge1xuICAgICAgICByZXR1cm4gJGF1dGguZ2V0U2Vzc2lvblVzZXIoKTtcbiAgICB9KVxuICAgIC5wcm92aWRlcignJGF1dGgnLCBhdXRoUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBhdXRoUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgbG9naW5VcmwsIGxvZ291dFVybCwgZGVidWcsIHJlY29ubmVjdGlvbk1heFRpbWUgPSAxNTtcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRMb2dpblVybCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBsb2dpblVybCA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLnNldExvZ291dFVybCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBsb2dvdXRVcmwgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy5zZXRSZWNvbm5lY3Rpb25NYXhUaW1lSW5TZWNzID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHJlY29ubmVjdGlvbk1heFRpbWUgPSB2YWx1ZSAqIDEwMDA7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uICgkcm9vdFNjb3BlLCAkbG9jYXRpb24sICR0aW1lb3V0LCAkcSwgJHdpbmRvdykge1xuXG4gICAgICAgIHZhciBzb2NrZXQ7XG4gICAgICAgIHZhciB1c2VyVG9rZW4gPSByZXRyaWV2ZVRva2VuKCk7XG4gICAgICAgIHZhciBzZXNzaW9uVXNlciA9IHsgY29ubmVjdGVkOiBmYWxzZSB9O1xuXG4gICAgICAgIGlmICghdXNlclRva2VuKSB7XG4gICAgICAgICAgICAvLyBAVE9ETzogdGhpcyByaWdodCB3YXkgdG8gcmVkaXJlY3QgaWYgd2UgaGF2ZSBubyB0b2tlbiB3aGVuIHdlIHJlZnJlc2ggb3IgaGl0IHRoZSBhcHAuXG4gICAgICAgICAgICAvLyAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IHdvdWxkIHByZXZlbnQgbW9zdCB1bml0IHRlc3RzIGZyb20gcnVubmluZyBiZWNhdXNlIHRoaXMgbW9kdWxlIGlzIHRpZ2hseSBjb3VwbGVkIHdpdGggYWxsIHVuaXQgdGVzdHMgKGRlcGVuZHMgb24gaXQpYXQgdGhpcyB0aW1lIDpcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnRva2VuID0gdXNlclRva2VuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0OiBjb25uZWN0LFxuICAgICAgICAgICAgbG9nb3V0OiBsb2dvdXQsXG4gICAgICAgICAgICBnZXRTZXNzaW9uVXNlcjogZ2V0U2Vzc2lvblVzZXJcbiAgICAgICAgfTtcblxuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZXNzaW9uVXNlcigpIHtcbiAgICAgICAgICAgIC8vIHRoZSBvYmplY3Qgd2lsbCBoYXZlIHRoZSB1c2VyIGluZm9ybWF0aW9uIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQuIE90aGVyd2lzZSBpdHMgY29ubmVjdGlvbiBwcm9wZXJ0eSB3aWxsIGJlIGZhbHNlOyBcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uVXNlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSBcbiAgICAgICAgICogdGhlIHN1Y2Nlc3MgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHNvY2tldCBhcyBhIHBhcmFtZXRlclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY29ubmVjdCgpIHtcbiAgICAgICAgICAgIGlmICghc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0dXAoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBnZXRGb3JWYWxpZENvbm5lY3Rpb24oKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxvZ291dCgpIHtcbiAgICAgICAgICAgIC8vIGNvbm5lY3Rpb24gY291bGQgYmUgbG9zdCBkdXJpbmcgbG9nb3V0Li5zbyBpdCBjb3VsZCBtZWFuIHdlIGhhdmUgbm90IGxvZ291dCBvbiBzZXJ2ZXIgc2lkZS5cbiAgICAgICAgICAgIGlmIChzb2NrZXQpIHtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnbG9nb3V0JywgdXNlclRva2VuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldEZvclZhbGlkQ29ubmVjdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvblVzZXIuY29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBiZWluZyB0aGUgc2NlbmUsIHNvY2tldC5pbyBpcyB0cnlpbmcgdG8gcmVjb25uZWN0IGFuZCBhdXRoZW50aWNhdGUgaWYgdGhlIGNvbm5lY3Rpb24gd2FzIGxvc3Q7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0KCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc29ja2V0KTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnVVNFUl9OT1RfQ09OTkVDVEVEJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlY29ubmVjdCgpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG5cbiAgICAgICAgICAgIGlmIChzZXNzaW9uVXNlci5jb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNvY2tldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvL0BUT0RPIFRPIFRISU5LIEFCT1VUOiwgaWYgdGhlIHNvY2tldCBpcyBjb25uZWN0aW5nIGFscmVhZHksIG1lYW5zIHRoYXQgYSBjb25uZWN0IHdhcyBjYWxsZWQgYWxyZWFkeSBieSBhbm90aGVyIGFzeW5jIGNhbGwsIHNvIGp1c3Qgd2FpdCBmb3IgdXNlcl9jb25uZWN0ZWRcblxuXG5cbiAgICAgICAgICAgIC8vIGlmIHRoZSByZXNwb25zZSBkb2VzIG5vdCBjb21lIHF1aWNrLi5sZXQncyBnaXZlIHVwIHNvIHdlIGRvbid0IGdldCBzdHVjayB3YWl0aW5nXG4gICAgICAgICAgICAvLyBAVE9ETzpvdGhlciB3YXkgaXMgdG8gd2F0Y2ggZm9yIGEgY29ubmVjdGlvbiBlcnJvci4uLlxuICAgICAgICAgICAgdmFyIGFjY2VwdGFibGVEZWxheTtcbiAgICAgICAgICAgIHZhciBvZmYgPSAkcm9vdFNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgb2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKGFjY2VwdGFibGVEZWxheSkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwoYWNjZXB0YWJsZURlbGF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzb2NrZXQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFjY2VwdGFibGVEZWxheSA9ICR0aW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBvZmYoKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH0sIHJlY29ubmVjdGlvbk1heFRpbWUpO1xuXG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwKCkge1xuICAgICAgICAgICAgaWYgKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBjYWxsZWQuLi5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgdG9rZW5WYWxpZGl0eVRpbWVvdXQ7XG4gICAgICAgICAgICAvLyBlc3RhYmxpc2ggY29ubmVjdGlvbiB3aXRob3V0IHBhc3NpbmcgdGhlIHRva2VuIChzbyB0aGF0IGl0IGlzIG5vdCB2aXNpYmxlIGluIHRoZSBsb2cpXG4gICAgICAgICAgICBzb2NrZXQgPSBpby5jb25uZWN0KHtcbiAgICAgICAgICAgICAgICAnZm9yY2VOZXcnOiB0cnVlLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHNvY2tldFxuICAgICAgICAgICAgICAgIC5vbignY29ubmVjdCcsIG9uQ29ubmVjdClcbiAgICAgICAgICAgICAgICAub24oJ2F1dGhlbnRpY2F0ZWQnLCBvbkF1dGhlbnRpY2F0ZWQpXG4gICAgICAgICAgICAgICAgLm9uKCd1bmF1dGhvcml6ZWQnLCBvblVuYXV0aG9yaXplZClcbiAgICAgICAgICAgICAgICAub24oJ2xvZ2dlZF9vdXQnLCBvbkxvZ091dClcbiAgICAgICAgICAgICAgICAub24oJ2Rpc2Nvbm5lY3QnLCBvbkRpc2Nvbm5lY3QpO1xuXG4gICAgICAgICAgICAvLyBUT0RPOiB0aGlzIGZvbGxvd293aW5nIGV2ZW50IGlzIHN0aWxsIHVzZWQuPz8/Li4uLlxuICAgICAgICAgICAgc29ja2V0XG4gICAgICAgICAgICAgICAgLm9uKCdjb25uZWN0X2Vycm9yJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgLy8gdGhlIHNvY2tldCBpcyBjb25uZWN0ZWQsIHRpbWUgdG8gcGFzcyB0aGUgdG9rZW4gdG8gYXV0aGVudGljYXRlIGFzYXBcbiAgICAgICAgICAgICAgICAvLyBiZWNhdXNlIHRoZSB0b2tlbiBpcyBhYm91dCB0byBleHBpcmUuLi5pZiBpdCBleHBpcmVzIHdlIHdpbGwgaGF2ZSB0byByZWxvZyBpblxuICAgICAgICAgICAgICAgIHNldENvbm5lY3Rpb25TdGF0dXMoZmFsc2UpO1xuICAgICAgICAgICAgICAgIHNvY2tldC5lbWl0KCdhdXRoZW50aWNhdGUnLCB7IHRva2VuOiB1c2VyVG9rZW4gfSk7IC8vIHNlbmQgdGhlIGp3dFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkRpc2Nvbm5lY3QoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1Nlc3Npb24gZGlzY29ubmVjdGVkJyk7IH1cbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRicm9hZGNhc3QoJ3VzZXJfZGlzY29ubmVjdGVkJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQXV0aGVudGljYXRlZChyZWZyZXNoVG9rZW4pIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIC8vIHRoZSBzZXJ2ZXIgY29uZmlybWVkIHRoYXQgdGhlIHRva2VuIGlzIHZhbGlkLi4ud2UgYXJlIGdvb2QgdG8gZ29cbiAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnYXV0aGVudGljYXRlZCwgcmVjZWl2ZWQgbmV3IHRva2VuOiAnICsgKHJlZnJlc2hUb2tlbiAhPSB1c2VyVG9rZW4pKTsgfVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS50b2tlbiA9IHJlZnJlc2hUb2tlbjtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSByZWZyZXNoVG9rZW47XG4gICAgICAgICAgICAgICAgc2V0TG9naW5Vc2VyKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyh0cnVlKTtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHVzZXJUb2tlbik7XG4gICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYnJvYWRjYXN0KCd1c2VyX2Nvbm5lY3RlZCcsc2Vzc2lvblVzZXIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkxvZ091dCgpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIC8vIHRva2VuIGlzIG5vIGxvbmdlciBhdmFpbGFibGUuXG4gICAgICAgICAgICAgICAgZGVsZXRlIGxvY2FsU3RvcmFnZS50b2tlbjtcbiAgICAgICAgICAgICAgICBzZXRDb25uZWN0aW9uU3RhdHVzKGZhbHNlKTtcbiAgICAgICAgICAgICAgICByZWRpcmVjdChsb2dvdXRVcmwgfHwgbG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVuYXV0aG9yaXplZChtc2cpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRva2VuVGltZW91dCgpO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCd1bmF1dGhvcml6ZWQ6ICcgKyBKU09OLnN0cmluZ2lmeShtc2cuZGF0YSkpOyB9XG4gICAgICAgICAgICAgICAgc2V0Q29ubmVjdGlvblN0YXR1cyhmYWxzZSk7XG4gICAgICAgICAgICAgICAgcmVkaXJlY3QobG9naW5VcmwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRDb25uZWN0aW9uU3RhdHVzKGNvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgIHNlc3Npb25Vc2VyLmNvbm5lY3RlZCA9IGNvbm5lY3RlZDtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUuZGVidWcoXCJDb25uZWN0aW9uIHN0YXR1czpcIiArIEpTT04uc3RyaW5naWZ5KHNlc3Npb25Vc2VyKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldExvZ2luVXNlcih0b2tlbikge1xuICAgICAgICAgICAgICAgIHZhciBwYXlsb2FkID0gZGVjb2RlKHRva2VuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5hc3NpZ24oc2Vzc2lvblVzZXIscGF5bG9hZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNsZWFyVG9rZW5UaW1lb3V0KCkge1xuICAgICAgICAgICAgICAgIGlmICh0b2tlblZhbGlkaXR5VGltZW91dCkge1xuICAgICAgICAgICAgICAgICAgICAkdGltZW91dC5jYW5jZWwodG9rZW5WYWxpZGl0eVRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVjb2RlKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NFVybCA9IHRva2VuLnNwbGl0KCcuJylbMV07XG4gICAgICAgICAgICAgICAgdmFyIGJhc2U2NCA9IGJhc2U2NFVybC5yZXBsYWNlKCctJywgJysnKS5yZXBsYWNlKCdfJywgJy8nKTtcbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IEpTT04ucGFyc2UoJHdpbmRvdy5hdG9iKGJhc2U2NCkpO1xuICAgICAgICAgICAgICAgIHJldHVybiBwYXlsb2FkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZXF1ZXN0TmV3VG9rZW5CZWZvcmVFeHBpcmF0aW9uKHRva2VuKSB7XG4gICAgICAgICAgICAgICAgLy8gcmVxdWVzdCBhIGxpdHRsZSBiZWZvcmUuLi5cbiAgICAgICAgICAgICAgICB2YXIgcGF5bG9hZCA9IGRlY29kZSh0b2tlbiwgeyBjb21wbGV0ZTogZmFsc2UgfSk7XG5cbiAgICAgICAgICAgICAgICB2YXIgaW5pdGlhbCA9IHBheWxvYWQuZHVyO1xuXG4gICAgICAgICAgICAgICAgdmFyIGR1cmF0aW9uID0gKGluaXRpYWwgKiA5MCAvIDEwMCkgfCAwO1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdTY2hlZHVsZSB0byByZXF1ZXN0IGEgbmV3IHRva2VuIGluICcgKyBkdXJhdGlvbiArICcgc2Vjb25kcyAodG9rZW4gZHVyYXRpb246JyArIGluaXRpYWwgKyAnKScpOyB9XG4gICAgICAgICAgICAgICAgdG9rZW5WYWxpZGl0eVRpbWVvdXQgPSAkdGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdUaW1lIHRvIHJlcXVlc3QgbmV3IHRva2VuICcgKyBpbml0aWFsKTsgfVxuICAgICAgICAgICAgICAgICAgICBzb2NrZXQuZW1pdCgnYXV0aGVudGljYXRlJywgeyB0b2tlbjogdG9rZW4gfSk7XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vdGU6IElmIGNvbW11bmljYXRpb24gY3Jhc2hlcyByaWdodCBhZnRlciB3ZSBlbWl0dGVkIGFuZCB3aGVuIHNlcnZlcnMgaXMgc2VuZGluZyBiYWNrIHRoZSB0b2tlbixcbiAgICAgICAgICAgICAgICAgICAgLy8gd2hlbiB0aGUgY2xpZW50IHJlZXN0YWJsaXNoZXMgdGhlIGNvbm5lY3Rpb24sIHdlIHdvdWxkIGhhdmUgdG8gbG9naW4gYmVjYXVzZSB0aGUgcHJldmlvdXMgdG9rZW4gd291bGQgYmUgaW52YWxpZGF0ZWQuXG4gICAgICAgICAgICAgICAgfSwgZHVyYXRpb24gKiAxMDAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJldHJpZXZlVG9rZW4oKSB7XG4gICAgICAgICAgICB2YXIgdXNlclRva2VuID0gJGxvY2F0aW9uLnNlYXJjaCgpLnRva2VuO1xuICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmRlYnVnKCdVc2luZyB0b2tlbiBwYXNzZWQgZHVyaW5nIHJlZGlyZWN0aW9uOiAnICsgdXNlclRva2VuKTsgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1c2VyVG9rZW4gPSBsb2NhbFN0b3JhZ2UudG9rZW47XG4gICAgICAgICAgICAgICAgaWYgKHVzZXJUb2tlbikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnVXNpbmcgVG9rZW4gaW4gbG9jYWwgc3RvcmFnZTogJyArIHVzZXJUb2tlbik7IH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHVzZXJUb2tlbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZGlyZWN0KHVybCkge1xuICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uLnJlcGxhY2UodXJsIHx8ICdiYWRVcmwuaHRtbCcpO1xuICAgICAgICB9XG4gICAgfTtcbn1cblxuIiwiXG4vKiogXG4gKiBUaGlzIHNlcnZpY2UgYWxsb3dzIHlvdXIgYXBwbGljYXRpb24gY29udGFjdCB0aGUgd2Vic29ja2V0IGFwaS5cbiAqIFxuICogSXQgd2lsbCBlbnN1cmUgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBhdmFpbGFibGUgYW5kIHVzZXIgaXMgYXV0aGVudGljYXRlZCBiZWZvcmUgZmV0Y2hpbmcgZGF0YS5cbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnemVydi5jb3JlJylcbiAgICAucHJvdmlkZXIoJyRzb2NrZXRpbycsIHNvY2tldGlvUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzb2NrZXRpb1Byb3ZpZGVyKCkge1xuICAgIHZhciBkZWJ1ZztcbiAgICB2YXIgdHJhbnNwb3J0ID0gd2luZG93LlpKU09OQklOIHx8IHsgc2VyaWFsaXplOiBub29wLCBkZXNlcmlhbGl6ZTogbm9vcCB9O1xuICAgIGZ1bmN0aW9uIG5vb3Aodikge1xuICAgICAgICByZXR1cm4gdjtcbiAgICB9XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHNvY2tldGlvU2VydmljZSgkcm9vdFNjb3BlLCAkcSwgJGF1dGgpIHtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb246IG9uLFxuICAgICAgICAgICAgZW1pdDogZW1pdCxcbiAgICAgICAgICAgIGxvZ291dDogJGF1dGgubG9nb3V0LFxuICAgICAgICAgICAgZmV0Y2g6IGZldGNoLFxuICAgICAgICAgICAgcG9zdDogcG9zdCxcbiAgICAgICAgICAgIG5vdGlmeTogbm90aWZ5XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudE5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0Lm9uKGV2ZW50TmFtZSwgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgJHJvb3RTY29wZS4kYXBwbHkoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkoc29ja2V0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBkZXByZWNhdGVkLCB1c2UgcG9zdC9ub3RpZnlcbiAgICAgICAgZnVuY3Rpb24gZW1pdChldmVudE5hbWUsIGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAkYXV0aC5jb25uZWN0KCkudGhlbihmdW5jdGlvbiAoc29ja2V0KSB7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoZXZlbnROYW1lLCBkYXRhLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgICAgICAgICAgICAgICAkcm9vdFNjb3BlLiRhcHBseShmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShzb2NrZXQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZldGNoIGRhdGEgdGhlIHdheSB3ZSBjYWxsIGFuIGFwaSBcbiAgICAgICAgICogaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8yMDY4NTIwOC93ZWJzb2NrZXQtdHJhbnNwb3J0LXJlbGlhYmlsaXR5LXNvY2tldC1pby1kYXRhLWxvc3MtZHVyaW5nLXJlY29ubmVjdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGZldGNoKG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ0ZldGNoaW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBub3RpZnkgaXMgc2ltaWxhciB0byBmZXRjaCBidXQgbW9yZSBtZWFuaW5nZnVsXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBub3RpZnkob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5kZWJ1ZygnTm90aWZ5aW5nICcgKyBvcGVyYXRpb24gKyAnLi4uJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBzb2NrZXRFbWl0KG9wZXJhdGlvbiwgZGF0YSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBwb3N0IHNlbmRzIGRhdGEgdG8gdGhlIHNlcnZlci5cbiAgICAgICAgICogaWYgZGF0YSB3YXMgYWxyZWFkeSBzdWJtaXR0ZWQsIGl0IHdvdWxkIGp1c3QgcmV0dXJuIC0gd2hpY2ggY291bGQgaGFwcGVuIHdoZW4gaGFuZGxpbmcgZGlzY29ubmVjdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBwb3N0KG9wZXJhdGlvbiwgZGF0YSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUuZGVidWcoJ1Bvc3RpbmcgJyArIG9wZXJhdGlvbiArICcuLi4nKTsgfVxuICAgICAgICAgICAgcmV0dXJuIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNvY2tldEVtaXQob3BlcmF0aW9uLCBkYXRhKSB7XG4gICAgICAgICAgICB2YXIgc2VyaWFsaXplZCA9IHRyYW5zcG9ydC5zZXJpYWxpemUoZGF0YSk7XG5cbiAgICAgICAgICAgIHJldHVybiAkYXV0aC5jb25uZWN0KClcbiAgICAgICAgICAgICAgICAudGhlbihvbkNvbm5lY3Rpb25TdWNjZXNzLCBvbkNvbm5lY3Rpb25FcnJvcilcbiAgICAgICAgICAgICAgICA7Ly8gLmNhdGNoKG9uQ29ubmVjdGlvbkVycm9yKTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkNvbm5lY3Rpb25TdWNjZXNzKHNvY2tldCkge1xuICAgICAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmVtaXQoJ2FwaScsIG9wZXJhdGlvbiwgc2VyaWFsaXplZCwgZnVuY3Rpb24gKHNlcmlhbGl6ZWRSZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gdHJhbnNwb3J0LmRlc2VyaWFsaXplKHNlcmlhbGl6ZWRSZXN1bHQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVidWcgJiYgY29uc29sZS5kZWJ1ZygnRXJyb3Igb24gJyArIG9wZXJhdGlvbiArICcgLT4nICsgSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoeyBjb2RlOiByZXN1bHQuY29kZSwgZGVzY3JpcHRpb246IHJlc3VsdC5kYXRhIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShyZXN1bHQuZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gb25Db25uZWN0aW9uRXJyb3IoZXJyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICRxLnJlamVjdCh7IGNvZGU6ICdDT05ORUNUSU9OX0VSUicsIGRlc2NyaXB0aW9uOiBlcnIgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbiJdfQ==

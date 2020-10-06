
describe('Unit testing for auth,', () => {
    let $auth;
    let socket;
    let sessionUser;
    let $timeout;
    let $rootScope;
    let authProvider;
    // user in token
    const refreshTokenUser = {display: 'test1'};
    const refreshedToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjIzMDkzNTJlLWM2OWItNDE4ZC04NTJiLTJiMTNkOGJiYjhhYiIsImRpc3BsYXkiOiJ0ZXN0MSIsImZpcnN0TmFtZSI6InRlc3QxIiwibGFzdE5hbWUiOiJ0ZXN0bDEiLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE0NjQxMDM5ODEsImV4cCI6MTQ2NDEwNDI4MiwianRpIjoxLCJkdXIiOjMwMH0.TIiSzCth7ed7tZFyt5lpqLrYtkNQzsscB9Yv0hlvjEQ';


    beforeEach(module('zerv.core', function($authProvider) {
        authProvider = $authProvider;
        $authProvider.setDebug(true);
    }));

    beforeEach(() => {
        mockSocket();
        mockIo();

        inject(function($injector, _$rootScope_, _$q_, _$timeout_) {
            $auth = $injector.get('$auth');
            sessionUser = $injector.get('sessionUser');
            $rootScope = _$rootScope_;
            $q = _$q_;
            $timeout = _$timeout_;
        });
        spyOn($auth, 'redirect');
    });


    afterEach(() => {
        window.localStorage.token = null;
    });

    describe('Connect', () => {
        it('should connect and store the new token and user', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect().finally(() => {
                expect(localStorage.token).toEqual(refreshedToken);
                expect(sessionUser.display).toEqual(refreshTokenUser.display);
                done();
            });
            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit('connect');
            socket.emit('authenticated', refreshedToken);
            $timeout.flush();
        });

        it('should connect using websocket as default transport', () => {
            localStorage.token = 'vvvv';
            $auth.connect();
            expect(window.io.connect).toHaveBeenCalledWith({forceNew: true, transports: ['websocket']});
        });

        it('should connect using long polling as a preference to initiate socket', () => {
            localStorage.token = 'vvvv';
            authProvider.enableLongPolling(true);
            $auth.connect();
            expect(window.io.connect).toHaveBeenCalledWith({forceNew: true});
        });

        it('should not receive the connect at all and timeout', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect().catch((err) => {
                expect(err).toEqual('USER_NOT_CONNECTED');
                done();
            });
            $rootScope.$apply();
            $timeout.flush();
        });

        it('should connect but timeout because not receiving the authenticated acknowledgement', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect().catch((err) => {
                expect(err).toEqual('USER_NOT_CONNECTED');
                done();
            });
            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit('connect');
            // socket.emit("authenticated", refreshedToken);
            $timeout.flush();
        });

        it('should already be connected if it connected before', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect().finally(() => {
                $auth.connect().finally(() => {
                    done();
                });
            });
            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit('connect');
            socket.emit('authenticated', refreshedToken);
            $timeout.flush();
        });
    });

    describe('logout', () => {
        it('should not call logout without connection', () => {
            $auth.logout();
            expect(socket.emit).not.toHaveBeenCalled();
        });

        it('should call emit logout then remove the token in local storage and redirect', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect().finally(() => {
                $auth.logout();
                // //fake server responding..
                socket.emit('logged_out');
                expect( localStorage.token ).not.toBeDefined();
                expect($auth.redirect).toHaveBeenCalled();
                //      expect(window.location.replace).toHaveBeenCalled();
                done();
            });

            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit('connect');
            socket.emit('authenticated', refreshedToken);
            $timeout.flush();
        });
    });

    describe('setSocketConnectionOptions', () => {
        it('should set the socket options', (done) => {
            localStorage.token = 'vvvv';
            authProvider.setSocketConnectionOptions({someSocketIoOption: 'value'});
            $auth.connect();
            expect( window.io.connect).toHaveBeenCalledWith({someSocketIoOption: 'value', forceNew: true, transports: ['websocket']});
            done();
        });

        it('should be set to default value (when not called)', (done) => {
            localStorage.token = 'vvvv';
            $auth.connect();
            expect( window.io.connect).toHaveBeenCalledWith({forceNew: true, transports: ['websocket']});
            done();
        });
    });


    describe('User inactivity monitor', () => {
        beforeEach(() => {
            jasmine.clock().install();
            jasmine.clock().mockDate();
            spyOn($auth, 'logout');
            localStorage.token = 'vvvv';
        });

        afterEach(() => {
            jasmine.clock().uninstall();
        });


        describe('setInactiveSessionTimeoutInMins', () => {
            it('should set to logout after time of inactivity', () => {
                $auth.setInactiveSessionTimeoutInMins(1);
                connectSession();
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 30*1000);
                expect($auth.getRemainingInactiveTime()).toBe(30000);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 30*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should set to logout to 7 days if setting is too high', () => {
                $auth.setInactiveSessionTimeoutInMins(10000000);
                connectSession();
                jasmine.clock().tick( 6 * 24 * 60 * 60*1000);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 24 * 60 * 60*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should set to logout to 7 days if setting is negative', () => {
                $auth.setInactiveSessionTimeoutInMins(-100);
                connectSession();
                jasmine.clock().tick( 7 * 24 * 60 * 60*1000);
                expect($auth.logout).not.toHaveBeenCalled();
            });

            it('should never logout when settings is set to 0', () => {
                $auth.setInactiveSessionTimeoutInMins(0);
                connectSession();
                jasmine.clock().tick( 7 * 24 * 60 * 60*1000);
                expect($auth.logout).not.toHaveBeenCalled();
            });

            it('should never logout when settings is set between 0 and 1', () => {
                $auth.setInactiveSessionTimeoutInMins(0.5);
                connectSession();
                jasmine.clock().tick( 7 * 24 * 60 * 60*1000);
                expect($auth.logout).not.toHaveBeenCalled();
            });

            it('should reset to logout after a different time of inactivity', (done) => {
                $auth.setInactiveSessionTimeoutInMins(1);
                connectSession();
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 30*1000);
                $auth.setInactiveSessionTimeoutInMins(1.25);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 30*1000);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 45*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
                done();
            });
        });

        describe('reset', () => {
            beforeEach(() => {
                $auth.setInactiveSessionTimeoutInMins(1);
                connectSession();
                jasmine.clock().tick(30*1000);
            });

            it('should occur on mousemove', () => {
                document.dispatchEvent(new Event('mousemove'));
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                jasmine.clock().tick( 30*1000);
                expect($auth.logout).not.toHaveBeenCalled();
                jasmine.clock().tick( 30*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should occur on mousedown', () => {
                document.dispatchEvent(new Event('mousedown'));
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                jasmine.clock().tick( 60*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should occur on keypress', () => {
                document.dispatchEvent(new Event('keypress'));
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                jasmine.clock().tick( 60*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should occur on touchmove', () => {
                document.dispatchEvent(new Event('touchmove'));
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                jasmine.clock().tick( 60*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });

            it('should occur maximum every second', () => {
                document.dispatchEvent(new Event('mousemove'));
                jasmine.clock().tick(500);
                document.dispatchEvent(new Event('mousemove'));
                // the timeout was not resetted despite the mousemove.
                expect($auth.getRemainingInactiveTime()).toBe(59500);
                jasmine.clock().tick(300);
                document.dispatchEvent(new Event('mousemove'));
                // the timeout was still not resetted despite the mousemove.
                expect($auth.getRemainingInactiveTime()).toBe(59200);
                jasmine.clock().tick(200);
                // 1s passed by since it was resetted, this new event will reset the timeout
                document.dispatchEvent(new Event('mousemove'));
                expect($auth.getRemainingInactiveTime()).toBe(60000);
                jasmine.clock().tick(60*1000);
                expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            });
        });


        function connectSession() {
            $auth.connect();
            $rootScope.$apply();
            socket.emit('connect');
            socket.emit('authenticated', refreshedToken);
            $timeout.flush();
        }
    });
    // //////////// HELPERS ///////////////////
    function mockIo() {
        window.io = {
            connect: jasmine.createSpy('ioConnect').and.callFake(() => socket),
        };
    }

    function mockSocket() {
        const socketListeners = {};
        socket = {
            emit: jasmine.createSpy('socketEmit'),
            on: function(event, fn) {
                // console.log("on: " + event);
                socketListeners[event] = fn;
                return socket;
            },
            connect: jasmine.createSpy('socketConnect'),
        };

        socket.emit.and.callFake(
            function(event, data, callback) {
                console.log('emiting ' + event);
                if (socketListeners[event]) {
                    var r = socketListeners[event](data);
                    if (callback) {
                        callback(r);
                    }
                }
            }
        );
    }
});

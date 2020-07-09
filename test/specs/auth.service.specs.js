
describe('Unit testing for auth,', function () {
    var mock, $auth, socket, sessionUser;
    var $q, $timeout, $rootScope;


    // user in token
    var refreshTokenUser = { display: 'test1' };
    var refreshedToken = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjIzMDkzNTJlLWM2OWItNDE4ZC04NTJiLTJiMTNkOGJiYjhhYiIsImRpc3BsYXkiOiJ0ZXN0MSIsImZpcnN0TmFtZSI6InRlc3QxIiwibGFzdE5hbWUiOiJ0ZXN0bDEiLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE0NjQxMDM5ODEsImV4cCI6MTQ2NDEwNDI4MiwianRpIjoxLCJkdXIiOjMwMH0.TIiSzCth7ed7tZFyt5lpqLrYtkNQzsscB9Yv0hlvjEQ";

    
    beforeEach(module('zerv.core',function($authProvider){
        $authProvider.setDebug(true);
    }));

    beforeEach(function () {
      
        mockSocket();
        mockIo();
        

        inject(function ($injector, _$rootScope_, _$q_, _$timeout_) {
            $auth = $injector.get('$auth');
            sessionUser = $injector.get('sessionUser');
            $rootScope = _$rootScope_;
            $q = _$q_;
            $timeout = _$timeout_;
        });
        spyOn($auth,'redirect'); 

    });
    
    

    afterEach(function () {
        window.localStorage.token = null;
    });

    describe('Connect', function () {

        it('should connect and store the new token and user', function (done) {
            localStorage.token = "vvvv";
            $auth.connect().finally(function () {
                expect(localStorage.token).toEqual(refreshedToken);
                expect(sessionUser.display).toEqual(refreshTokenUser.display);
                done();
            });

            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
        });

        it('should not receive the connect at all and timeout', function (done) {
            localStorage.token = "vvvv";
            $auth.connect().catch(function (err) {
                expect(err).toEqual('USER_NOT_CONNECTED');
                done();
            });
            $rootScope.$apply();
            $timeout.flush();
        });

        it('should connect but timeout because not receiving the authenticated acknowledgement', function (done) {
            localStorage.token = "vvvv";
            $auth.connect().catch(function (err) {
                expect(err).toEqual('USER_NOT_CONNECTED');
                done();
            });
            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit("connect");
            //socket.emit("authenticated", refreshedToken);
            $timeout.flush();
        });

        it('should already be connected if it connected before', function (done) {
            localStorage.token = "vvvv";
            $auth.connect().finally(function () {
                $auth.connect().finally(function () {
                    done();
                });
            });
            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
        });


    });

    describe('logout', function () {

        it('should not call logout without connection', function () {
            $auth.logout();
            expect(socket.emit).not.toHaveBeenCalled();
        });

        it('should call emit logout then remove the token in local storage and redirect', function (done) {
            localStorage.token = "vvvv";
            $auth.connect().finally(function () {
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
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
        });
    });

    describe('setInactiveSessionTimeoutInMins', () => {
        beforeEach(() => {
            jasmine.clock().install();
            jasmine.clock().mockDate();
        });
    
        afterEach(() => {
            jasmine.clock().uninstall();
        });

        it('should set to logout after time of inactivity', (done) => {
            spyOn($auth, 'logout');
            localStorage.token = "vvvv";
            $auth.setInactiveSessionTimeoutInMins(1);
            $auth.connect();
            $rootScope.$apply();
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
            expect($auth.logout).not.toHaveBeenCalled();
            jasmine.clock().tick( 30*1000);
            expect($auth.logout).not.toHaveBeenCalled();
            jasmine.clock().tick( 30*1000);
            expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
            done();
        });

        it('should set to logout to 7 days if setting is too high', () => {
            spyOn($auth, 'logout');
            localStorage.token = "vvvv";
            $auth.setInactiveSessionTimeoutInMins(10000000);
            $auth.connect();
            $rootScope.$apply();
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
            jasmine.clock().tick( 6 * 24 * 60 * 60*1000);
            expect($auth.logout).not.toHaveBeenCalled();
            jasmine.clock().tick( 24 * 60 * 60*1000);
            expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
        });

        it('should set to logout to 7 days if setting is negative', () => {
            spyOn($auth, 'logout');
            localStorage.token = "vvvv";
            $auth.setInactiveSessionTimeoutInMins(-100);
            $auth.connect();
            $rootScope.$apply();
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
            jasmine.clock().tick( 6 * 24 * 60 * 60*1000);
            expect($auth.logout).not.toHaveBeenCalled();
            jasmine.clock().tick( 24 * 60 * 60*1000);
            expect($auth.logout).toHaveBeenCalledWith('inactive_session_timeout');
        });

        it('should never logout when settings is set to 0', () => {
            spyOn($auth, 'logout');
            localStorage.token = "vvvv";
            $auth.setInactiveSessionTimeoutInMins(0);
            $auth.connect();
            $rootScope.$apply();
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
            jasmine.clock().tick( 7 * 24 * 60 * 60*1000);
            expect($auth.logout).not.toHaveBeenCalled();
        });

        it('should reset to logout after a different time of inactivity', (done) => {
            spyOn($auth, 'logout');
            localStorage.token = "vvvv";
            $auth.setInactiveSessionTimeoutInMins(1);
            $auth.connect();
            $rootScope.$apply();
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
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
    ////////////// HELPERS ///////////////////
    function mockIo() {
        window.io = {
            connect: function () {
                return socket;
            }
        };
    }
    
    function mockSocket() {
        var socketListeners = {};
        socket = {
            emit: null,
            on: function (event, fn) {
               // console.log("on: " + event);
                socketListeners[event] = fn;
                return socket;
            },
            connect: () => _.noop
        }

        spyOn(socket, 'emit').and.callFake(
            function (event, data, callback) {
                console.log("emiting " + event);
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
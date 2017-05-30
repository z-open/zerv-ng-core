
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
        
        spyOn(window.location,'replace'); 

        inject(function ($injector, _$rootScope_, _$q_, _$timeout_) {
            $auth = $injector.get('$auth');
            sessionUser = $injector.get('sessionUser');
            $rootScope = _$rootScope_;
            $q = _$q_;
            $timeout = _$timeout_;
        });

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
                expect(window.location.replace).toHaveBeenCalled();
                 done();
            });

            $rootScope.$apply();
            // fake server responding to the socket
            socket.emit("connect");
            socket.emit("authenticated", refreshedToken);
            $timeout.flush();
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
            }
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
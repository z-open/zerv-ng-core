describe('Unit testing for socket,', function () {
    let socket, socketService;
    let $q, $timeout, $rootScope;
    let socketResponse, connectError;
    let dataToEmit;
    let $auth;
    var someData;

    beforeEach(module('zerv.core', function ($socketioProvider) {
        $socketioProvider.setDebug(true);
    }));

    beforeEach(function () {

        someData = 'precious data';

        dataToEmit = { someField: 'someValue' };

        socket = {
            emit: (event, operation, data, callback) => {
                // console.log("emiting");
                callback(socketResponse);
            }
        };

        spyOn(socket, 'emit').and.callThrough();

        connectError = null;
        const mockAuthService = {
            connect: function () {
                var deferred = $q.defer();
                if (connectError) {
                    deferred.reject(connectError);
                }
                else {
                    deferred.resolve(socket);
                }
                return deferred.promise;
            },
            addConnectionListener: jasmine.createSpy('addConnectionListener')
        };

        module(function ($provide) {
            // $provide.value('$window', mock);
            $provide.value('$auth', mockAuthService);
            $auth = mockAuthService;
        });

        inject(function ($injector, _$rootScope_, _$q_, _$timeout_) {
            socketService = $injector.get('$socketio');
            $rootScope = _$rootScope_;
            $q = _$q_;
            $timeout = _$timeout_;

        });
    });


    describe('Fetch', function () {

        it('should return the data ', function (done) {
            var someData = 'precious data';
            socketResponse = { data: someData };
            socketService.fetch('test', {}).then(function (data) {
                expect(data).toEqual(someData);
                done();
            });
            $rootScope.$apply();
        });

        it('should catch and return an error received from the backend', function (done) {
            var someErrCode = 'BACKEND_ERR';
            var someErrDescription = 'Something happened';
            socketResponse = { code: someErrCode, data: someErrDescription };
            socketService.fetch('test', {}).catch(function (err) {
                expect(err.code).toEqual(someErrCode);
                expect(err.description).toEqual(someErrDescription);
                done();
            });
            $rootScope.$apply();
        });

        it('should catch the connection error ', function (done) {
            connectError = true;
            socketService.fetch('test', {}).catch(function (err) {
                expect(err.code).toEqual('CONNECTION_ERR');
                done();
            });
            $rootScope.$apply();

        });
    });

    describe('_socketEmit', function () {

        beforeEach(() => {
            jasmine.clock().install();
            jasmine.clock().mockDate();
        });

        afterEach(() => {
            jasmine.clock().uninstall();
        });

        it('should return the data ', function (done) {
            var someData = 'precious data';
            socketResponse = { data: someData };
            socketService
                ._socketEmit('test', dataToEmit,'emitTest')
                .then(function (data) {
                    expect(socket.emit).toHaveBeenCalledWith(
                        'api',
                        'test', 
                        dataToEmit, 
                        jasmine.any(Function)

                    );
                    expect(data).toEqual(someData);
                    done();
                });
            $rootScope.$apply();
        });

        it('should catch and return an error received from the backend', function (done) {
            var someErrCode = 'BACKEND_ERR';
            var someErrDescription = 'Something happened';
            socketResponse = { code: someErrCode, data: someErrDescription };

            socketService
                ._socketEmit('test', dataToEmit,'emitTest')
                .catch(function (err) {
                    expect(err.code).toEqual(someErrCode);
                    expect(err.description).toEqual(someErrDescription);
                    done();
                });

            $rootScope.$apply();
        });

        it('should catch the connection error ', function (done) {
            connectError = true;

            socketService
                ._socketEmit('test', dataToEmit,'emitTest')
                .catch(function (err) {
                    expect(err.code).toEqual('CONNECTION_ERR');
                    done();
                });
            $rootScope.$apply();
        });

        it('should time out with the default timeout', function (done) {
            let check = 0;
            socket.emit.and.returnValue(null);
            socketService
                ._socketEmit('test', dataToEmit,'emitTest')
                .catch(function (err) {
                    expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
                    expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 120 secs and 1 attempt(s)');
                    expect(check).toEqual(2);
                    done();
                });
            jasmine.clock().tick( 119 * 1000);
            check = 1;
            $rootScope.$apply();
            jasmine.clock().tick( 1 * 1000);
            check = 2;
            $rootScope.$apply();

        });

        it('should time out with the provided value', function (done) {
            socket.emit.and.returnValue(null);
            socketService
                ._socketEmit('test', dataToEmit,'emitTest', { timeout: 180 })
                .catch(function (err) {
                    expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
                    expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 180 secs and 1 attempt(s)');
                    done();
                });
            jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
        });

        it('should retry on network reconnection the default 3 times and give up', function (done) {
            let connectListenerFn;
            $auth.addConnectionListener.and.callFake((fn) => { connectListenerFn = fn; return _.noop});

            socket.emit.and.returnValue(null);
            socketService
                ._socketEmit('test', dataToEmit,'emitTest', { timeout: 180 })
                .catch(function (err) {
                    expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
                    expect(err.description).toEqual('Failed to emit to [emitTest/test] or process response - Made 3 attempt(s)');
                    expect(socket.emit).toHaveBeenCalledTimes(3);
                    done();
                });
            // jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(1);


            // the first emit did not complete since system has just reconnected
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(2);

            // the 2nd emit did not complete since system has just reconnected
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(3);
            // the 3rd emit did not complete since system has just reconnected
            // and the timeout has not kicked in
            // then they is 3 reconnections, but this time we reach 
            // number of attempts despite timeout is up
            // so it is time to give up
            connectListenerFn();
            $rootScope.$apply();
            // no more trying
            expect(socket.emit).toHaveBeenCalledTimes(3);
        });

        it('should retry on network reconnection and succeed', function (done) {
            let attempts = 1;

            let connectListenerFn;
            $auth.addConnectionListener.and.callFake((fn) => { connectListenerFn = fn; return _.noop});
            socketResponse = { data: someData };

            socket.emit.and.callFake((event, operation, data, callback) => {
                if (attempts === 2) {
                    callback({ data: someData });
                }
            });
            socketService
                ._socketEmit('test', dataToEmit,'emitTest', { timeout: 180 })
                .then(function (data) {
                    expect(socket.emit).toHaveBeenCalledTimes(2);
                    expect(socket.emit).toHaveBeenCalledWith(
                        'api',
                        'test', 
                        dataToEmit, 
                        jasmine.any(Function)

                    );
                    expect(data).toEqual(someData);
                    done();
                })
                .catch(function (err) {
                    done.fail('Should have not failed with ' + JSON.stringify(err));
                });
            // jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(1);

            // the first emit did not complete since system has just reconnected
            attempts++;
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(2);
        });

        it('should retry on network reconnection the provided number of times', function (done) {
            let connectListenerFn;
            $auth.addConnectionListener.and.callFake((fn) => { connectListenerFn = fn; return _.noop});

            socket.emit.and.returnValue(null);
            socketService
                ._socketEmit('test', dataToEmit,'emitTest', { attempts: 2 })
                .catch(function (err) {
                    expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
                    expect(err.description).toEqual('Failed to emit to [emitTest/test] or process response - Made 2 attempt(s)');
                    expect(socket.emit).toHaveBeenCalledTimes(2);
                    done();
                });
            // jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(1);


            // the first emit did not complete since system has just reconnected
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(2);

            // the 2nd emit did not complete since system has just reconnected
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(2);
        });

        it('should retry on network reconnection only 2 times and give up because of the timeout', function (done) {
            let connectListenerFn;
            $auth.addConnectionListener.and.callFake((fn) => { connectListenerFn = fn; return _.noop});

            socket.emit.and.returnValue(null);
            socketService
                ._socketEmit('test', dataToEmit,'emitTest', { timeout: 60, attempts: 3 })
                .catch(function (err) {
                    expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
                    expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 60 secs and 2 attempt(s)');
                    expect(socket.emit).toHaveBeenCalledTimes(2);
                    done();
                });
            // jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(1);


            // the first emit did not complete since system has just reconnected
            connectListenerFn();
            $rootScope.$apply();
            expect(socket.emit).toHaveBeenCalledTimes(2);

            jasmine.clock().tick( 180 * 1000);
            $rootScope.$apply();
        });
      

    });
});
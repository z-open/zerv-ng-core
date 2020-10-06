describe('Unit testing for socket,', function() {
  let spec;

  beforeEach(module('zerv.core', function($socketioProvider) {
    $socketioProvider.setDebug(true);
  }));

  beforeEach(function() {
    spec = {};

    spec.someDataToReceive = 'precious data';

    spec.dataToEmit = {someField: 'someValue'};

    spec.socket = {
      emit: (event, operation, data, callback) => {
        // console.log("emiting");
        callback(spec.socketResponse);
      },
    };

    spyOn(spec.socket, 'emit').and.callThrough();

    spec.connectError = null;

    const mockAuthService = {
      connect: function() {
        var deferred = spec.$q.defer();
        if (spec.connectError) {
          deferred.reject(spec.connectError);
        } else {
          deferred.resolve(spec.socket);
        }
        return deferred.promise;
      },
      addConnectionListener: jasmine.createSpy('addConnectionListener'),
    };


    mockAuthService.addConnectionListener.and.callFake((fn) => {
      spec.notifyNetworkReconnection = fn; return _.noop;
    });

    module(function($provide) {
      // $provide.value('$window', mock);
      $provide.value('$auth', mockAuthService);
    });

    inject(function($injector, _$rootScope_, _$q_, _$timeout_) {
      spec.socketService = $injector.get('$socketio');
      spec.$rootScope = _$rootScope_;
      spec.$q = _$q_;
      spec.$timeout = _$timeout_;
    });
  });


  xdescribe('Fetch', function() {
    it('should return the data ', function(done) {
      var someData = 'precious data';
      spec.socketResponse = {data: someData};
      spec.socketService.fetch('test', {}).then(function(data) {
        expect(data).toEqual(someData);
        done();
      });
      spec.$rootScope.$apply();
    });

    it('should catch and return an error received from the backend', function(done) {
      var someErrCode = 'BACKEND_ERR';
      var someErrDescription = 'Something happened';
      spec.socketResponse = {code: someErrCode, data: someErrDescription};
      spec.socketService.fetch('test', {}).catch(function(err) {
        expect(err.code).toEqual(someErrCode);
        expect(err.description).toEqual(someErrDescription);
        done();
      });
      spec.$rootScope.$apply();
    });

    it('should catch the connection error ', function(done) {
      spec.connectError = true;
      spec.socketService.fetch('test', {}).catch(function(err) {
        expect(err.code).toEqual('CONNECTION_ERR');
        done();
      });
      spec.$rootScope.$apply();
    });
  });

  describe('_socketEmit', function() {
    beforeEach(() => {
      jasmine.clock().install();
      jasmine.clock().mockDate();
    });

    afterEach(() => {
      jasmine.clock().uninstall();
    });

    it('should return the data ', function(done) {
      var someData = 'precious data';
      spec.socketResponse = {data: someData};
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest')
          .then(function(data) {
            expect(spec.socket.emit).toHaveBeenCalledWith(
                'api',
                'test',
                spec.dataToEmit,
                jasmine.any(Function)

            );
            expect(data).toEqual(someData);
            done();
          });
      spec.$rootScope.$apply();
    });

    it('should catch and return an error received from the backend', function(done) {
      const someErrCode = 'BACKEND_ERR';
      const someErrDescription = 'Something happened';
      spec.socketResponse = {code: someErrCode, data: someErrDescription};

      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest')
          .catch(function(err) {
            expect(err.code).toEqual(someErrCode);
            expect(err.description).toEqual(someErrDescription);
            done();
          });

      spec.$rootScope.$apply();
    });

    it('should catch the connection error ', function(done) {
      spec.connectError = true;

      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest')
          .catch(function(err) {
            expect(err.code).toEqual('CONNECTION_ERR');
            done();
          });
      spec.$rootScope.$apply();
    });

    it('should time out with the default timeout', function(done) {
      let check = 0;
      spec.socket.emit.and.returnValue(null);
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest')
          .catch(function(err) {
            expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
            expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 120 secs and 1 attempt(s)');
            expect(check).toEqual(2);
            done();
          });
      jasmine.clock().tick( 119 * 1000);
      check = 1;
      spec.$rootScope.$apply();
      jasmine.clock().tick( 1 * 1000);
      check = 2;
      spec.$rootScope.$apply();
    });

    it('should time out with the provided value', function(done) {
      spec.socket.emit.and.returnValue(null);
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest', {timeout: 180})
          .catch(function(err) {
            expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
            expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 180 secs and 1 attempt(s)');
            done();
          });
      jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
    });

    it('should retry on network reconnection the default 3 times and give up', function(done) {
      spec.socket.emit.and.returnValue(null);
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest', {timeout: 180})
          .catch(function(err) {
            expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
            expect(err.description).toEqual('Failed to emit to [emitTest/test] or process response - Made 3 attempt(s)');
            expect(spec.socket.emit).toHaveBeenCalledTimes(3);
            done();
          });
      // jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(1);


      // the first emit did not complete since system has just reconnected
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(2);

      // the 2nd emit did not complete since system has just reconnected
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(3);
      // the 3rd emit did not complete since system has just reconnected
      // and the timeout has not kicked in
      // then they is 3 reconnections, but this time we reach
      // number of attempts despite timeout is up
      // so it is time to give up
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      // no more trying
      expect(spec.socket.emit).toHaveBeenCalledTimes(3);
    });

    it('should retry on network reconnection and succeed', function(done) {
      let attempts = 1;

      spec.socket.emit.and.callFake((event, operation, data, callback) => {
        if (attempts === 2) {
          callback({data: spec.someDataToReceive});
        }
      });
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest', {timeout: 180})
          .then(function(data) {
            expect(spec.socket.emit).toHaveBeenCalledTimes(2);
            expect(spec.socket.emit).toHaveBeenCalledWith(
                'api',
                'test',
                spec.dataToEmit,
                jasmine.any(Function)

            );
            expect(data).toEqual(spec.someDataToReceive);
            done();
          })
          .catch(function(err) {
            done.fail('Should have not failed with ' + JSON.stringify(err));
          });
      // jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(1);

      // the first emit did not complete since system has just reconnected
      attempts++;
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(2);
    });

    it('should retry on network reconnection the provided number of times', function(done) {
      spec.socket.emit.and.returnValue(null);
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest', {attempts: 2})
          .catch(function(err) {
            expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
            expect(err.description).toEqual('Failed to emit to [emitTest/test] or process response - Made 2 attempt(s)');
            expect(spec.socket.emit).toHaveBeenCalledTimes(2);
            done();
          });
      // jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(1);


      // the first emit did not complete since system has just reconnected
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(2);

      // the 2nd emit did not complete since system has just reconnected
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(2);
    });

    it('should retry on network reconnection only 2 times and give up because of the timeout', function(done) {
      spec.socket.emit.and.returnValue(null);
      spec.socketService
          ._socketEmit('test', spec.dataToEmit, 'emitTest', {timeout: 60, attempts: 3})
          .catch(function(err) {
            expect(err.code).toEqual('NO_SERVER_RESPONSE_ERR');
            expect(err.description).toEqual('Failed to emit [emitTest/test] or process response - Network or browser too busy - timed out after 60 secs and 2 attempt(s)');
            expect(spec.socket.emit).toHaveBeenCalledTimes(2);
            done();
          });
      // jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(1);


      // the first emit did not complete since system has just reconnected
      spec.notifyNetworkReconnection();
      spec.$rootScope.$apply();
      expect(spec.socket.emit).toHaveBeenCalledTimes(2);

      jasmine.clock().tick( 180 * 1000);
      spec.$rootScope.$apply();
    });
  });
});

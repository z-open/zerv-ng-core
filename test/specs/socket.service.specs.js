describe('Unit testing for socket,', function() {
  let spec;

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

    module('zerv.core', function($socketioProvider) {
      $socketioProvider.setDebug(true);
      spec.$socketioProvider = $socketioProvider;
    });

    module(function($provide) {
      // $provide.value('$window', mock);
      $provide.value('$auth', mockAuthService);
      spec.$auth = mockAuthService;
    });

    inject(function($injector, _$rootScope_, _$q_, _$timeout_) {
      spec.socketService = $injector.get('$socketio');
      spec.$rootScope = _$rootScope_;
      spec.$q = _$q_;
      spec.$timeout = _$timeout_;
    });
  });

  describe('setDefaultFetchTimeoutInSecs', () => {
    it('should set a specific value', () => {
      spec.$socketioProvider.setDefaultFetchTimeoutInSecs(60);
      expect(spec.$socketioProvider.getDefaultFetchMaxTimeout()).toEqual(60);
    });

    it('should be set to default value', () => {
      expect(spec.$socketioProvider.getDefaultFetchMaxTimeout()).toEqual(120);
    });
  });

  describe('setDefaultMaxFetchAttempts', () => {
    it('should set a specific value', () => {
      spec.$socketioProvider.setDefaultMaxFetchAttempts(5);
      expect(spec.$socketioProvider.getDefaultMaxFetchAttempts()).toEqual(5);
    });

    it('should be set to default value', () => {
      expect(spec.$socketioProvider.getDefaultMaxFetchAttempts()).toEqual(3);
    });
  });

  describe('setDefaultPostTimeoutInSecs', () => {
    it('should set a specific value', () => {
      spec.$socketioProvider.setDefaultPostTimeoutInSecs(60);
      expect(spec.$socketioProvider.getDefaultPostMaxTimeout()).toEqual(60);
    });

    it('should be set to default value', () => {
      expect(spec.$socketioProvider.getDefaultPostMaxTimeout()).toEqual(300);
    });
  });


  describe('fetch function', function() {
    beforeEach(() => {
      spyOn(spec.socketService, '_socketEmit').and.returnValue(Promise.resolve(spec.socketResponse));
    });

    it('should call the low level _socketEmit function with the default options', function(done) {
      spec.socketResponse = {data: spec.someData};
      spec.socketService.fetch('test', spec.dataToEmit).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'fetch',
            {}
        );
        expect(data).toEqual(spec.someData);
        done();
      });
      spec.$rootScope.$apply();
    });

    it('should call the low level _socketEmit function with the provided options', function(done) {
      spec.socketResponse = {data: spec.someData};
      const options = {timeout: 100, attempts: 5};
      spec.socketService.fetch('test', spec.dataToEmit, options).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'fetch',
            options
        );
        expect(data).toEqual(spec.someData);
        done();
      });
      spec.$rootScope.$apply();
    });
  });

  describe('Notify function', function() {
    beforeEach(() => {
      spyOn(spec.socketService, '_socketEmit').and.returnValue(Promise.resolve(spec.socketResponse));
    });

    it('should call the low level _socketEmit function with the default options', function(done) {
      spec.socketResponse = {data: spec.someData};
      spec.socketService.notify('test', spec.dataToEmit).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'notify',
            {}
        );
        expect(data).toEqual(spec.someData);
        done();
      });
      spec.$rootScope.$apply();
    });

    it('should call the low level _socketEmit function with the provided options', function(done) {
      spec.socketResponse = {data: spec.someData};
      const options = {timeout: 100, attempts: 5};
      spec.socketService.notify('test', spec.dataToEmit, options).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'notify',
            options
        );
        expect(data).toEqual(spec.someData);
        done();
      });
      spec.$rootScope.$apply();
    });
  });

  describe('post function', function() {
    beforeEach(() => {
      spyOn(spec.socketService, '_socketEmit').and.returnValue(Promise.resolve(spec.socketResponse));
    });

    it('should call the low level _socketEmit function with the default options which is one attempt only', function(done) {
      spec.socketResponse = {data: spec.someData};
      spec.socketService.post('test', spec.dataToEmit).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'post',
            {
              attempts: 1,
              timeout: 300,
            }
        );
        expect(data).toEqual(spec.someData);
        done();
      });
      spec.$rootScope.$apply();
    });

    it('should call the low level _socketEmit function with the provided options', function(done) {
      spec.socketResponse = {data: spec.someData};
      const options = {timeout: 60, attempts: 5};
      spec.socketService.post('test', spec.dataToEmit, options).then(function(data) {
        expect(spec.socketService._socketEmit).toHaveBeenCalledWith(
            'test',
            spec.dataToEmit,
            'post',
            options
        );
        expect(data).toEqual(spec.someData);
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

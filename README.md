
## Description
This bower package provides the angular client to use the secured API running on a socketio.auth infrastructure based Express server.
This client enables the following:
- maintaining a secure/authenticated connection via websocket 
- access to an api via websocket


## Pre-requiste
- Set up your socketio.auth based express server. Check socketio.auth git repository.
- Use $http to contact the server login api and retrieve a token then store it in localStorage.token
- define an api on the server (see socketio.auth and use socketIoAuth.apiRouter)

## Usage
- use $socketio.fetch to get the data from your api
- use the service sessionUser to get the current user. unless you get its connection property set to false. 
The sessionUser object will contain the following properties: id, lastName, firstName, display, role and profile. In addition, Anything else within the socket paypload.profile will be available in sessionUser.profile. 

Events:
user_connected and user_disconnected events are broadcasted on connection status change.


ex:
```javascript
$socketio.fetch('member.findById',id)
.then(function(data) {
    // do something with your data returned from your api
    })
.catch(function(err) {
    // do something with the err.code, err.description
    })
```

## Installation

```
bower install "git://github.com/z-open/angular-socketio#commit-ish
```
Afterwards, the module to add to your angular application is named socketio-auth.

## Example 
```javascript
```

__Client side__:

```javascript
```
__Server side__:
```javascript
```



## Contribute

You are always welcome to open an issue or provide a pull-request!

Check out the unit tests.
First download/extract or clone this git repository then...
```bash
npm install
gulp
```
Note:
Gulp build: build this library for dev (with map) and prod (minify,uglify)
gulp: build all and run continuous testing.
## Issue Reporting


If you have found a bug or if you have a feature request, please report them at this repository issues section. Please do not report security vulnerabilities on the public GitHub issue tracker. 

## Author

[z-open]

## License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for more info.

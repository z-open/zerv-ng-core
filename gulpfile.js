// ////////////////////////////////////////////
// Modules
// ////////////////////////////////////////////

// the main gulp reference
var gulp = require('gulp');

const babel = require('gulp-babel');

// deletes files used during build (https://www.npmjs.com/package/gulp-clean)
var clean = require('gulp-clean');

// combines files into a single destination file (https://github.com/wearefractal/gulp-concat)
var concat = require('gulp-concat');

// angular.js annotation for compression (https://www.npmjs.com/package/gulp-ng-annotate)
var annotate = require('gulp-ng-annotate');

// add an IIFE to each file () 
var iife = require('gulp-iife');

// watches files for changes and reruns tasks (https://www.npmjs.com/package/gulp-watch)
var watch = require('gulp-watch');

// karma server to run automated unit tests (http://karma-runner.github.io/0.13/index.html)
var Server = require('karma').Server;

// gulp-bump (https://www.npmjs.com/package/gulp-bump)
var bump = require('gulp-bump');

// git-describe (https://www.npmjs.com/package/git-describe)
var gitDescribe = require('git-describe');


// ////////////////////////////////////////////
// Variables
// ////////////////////////////////////////////

// All application JS files.
var appFiles = [
// 'api/models/**/*.model.js',
    'src/**/*.js'];

// ////////////////////////////////////////////
// Tasks
// ////////////////////////////////////////////

gulp.task('lib', function() {
    return gulp.src(appFiles)
        .pipe(iife({
            useStrict: true,
            trimCode: true,
            prependSemicolon: false,
            bindThis: false,
        }))
        .pipe(babel({
            presets: ['env'],
        }))
        .pipe(concat('zerv-ng-core.js'))
        .pipe(annotate())
        .pipe(gulp.dest('dist/'));
});


// single run testing
gulp.task('test', function(done) {
    new Server({configFile: __dirname + '/karma.conf.js', singleRun: true},
        function(code) {
            if (code == 1) {
                console.log('Unit Test failures, exiting process');
                // done(new Error(`Karma exited with status code ${code}`));
                return process.exit(code);
            } else {
                console.log('Unit Tests passed');
                done();
            }
        }).start();
});

// continuous testing
gulp.task('tdd', function(done) {
    new Server({configFile: __dirname + '/karma.conf.js'}, function() {
        done();
    }).start();
});

// watch the app .js files for changes and execute the app-js task if necessary
gulp.task('app-watch', function() {
    watch(appFiles, function(file) {
    });
});

// clean up files after builds
gulp.task('cleanup', function() {
    return gulp.src('build', {read: false}).pipe(clean());
});

// bump the dev version (NOTE: NOT IN USE RIGHT NOW)
gulp.task('bump-dev', function() {
    var gitInfo = gitDescribe(__dirname);

    gulp.src(['./bower.json', './package.json'])
        .pipe(bump({type: 'prerelease', preid: gitInfo.hash}))
        .pipe(gulp.dest('./'));
});

// build angular-socketio.js for dev (with map) 
gulp.task('build', ['lib'], function() {
        gulp.start(['test', 'cleanup']);
});


// continuous watchers
gulp.task('default', ['lib'], function() {
    gulp.start(['app-watch', 'tdd']);
});



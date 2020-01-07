// ////////////////////////////////////////////
// Modules
// ////////////////////////////////////////////

// the main gulp reference
var gulp = require('gulp');

const babel = require('gulp-babel');

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

gulp.task('lib', function () {
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
gulp.task('test', function (done) {
    new Server({ configFile: __dirname + '/karma.conf.js', singleRun: true },
        function (code) {
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
gulp.task('tdd', function (done) {
    new Server({ configFile: __dirname + '/karma.conf.js' }, function () {
        done();
    }).start();
});

// watch the app .js files for changes and execute the app-js task if necessary
gulp.task('app-watch', function () {
    watch(appFiles, function (file) {
    });
});


gulp.task('build', gulp.series('lib', 'test'));

gulp.task('default', gulp.series('lib', 'app-watch', 'tdd'));



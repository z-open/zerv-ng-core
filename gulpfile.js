// ////////////////////////////////////////////
// Modules
// ////////////////////////////////////////////

// the main gulp reference
const gulp = require('gulp');

const babel = require('gulp-babel');

// deletes files used during build (https://www.npmjs.com/package/gulp-clean)
const clean = require('gulp-clean');

// combines files into a single destination file (https://github.com/wearefractal/gulp-concat)
const concat = require('gulp-concat');

// angular.js annotation for compression (https://www.npmjs.com/package/gulp-ng-annotate)
const annotate = require('gulp-ng-annotate');

// add an IIFE to each file () 
const iife = require('gulp-iife');

// karma server to run automated unit tests (http://karma-runner.github.io/0.13/index.html)
const Server = require('karma').Server;

// ////////////////////////////////////////////
// Variables
// ////////////////////////////////////////////

// All application JS files.
const appFiles = [
    'src/**/*.js'
];

// ////////////////////////////////////////////
// Tasks
// ////////////////////////////////////////////

gulp.task('lib', () => {
    return gulp.src(appFiles)
        .pipe(iife({
            useStrict: false,
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
gulp.task('test', (done) => {
    new Server({configFile: __dirname + '/karma.conf.js', singleRun: true}, (code) => {
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
gulp.task('tdd', (done) => {
    new Server({configFile: __dirname + '/karma.conf.js'}, () => {
        done();
    }).start();
});

gulp.task('build', gulp.series('lib', 'test'));

gulp.task('default', gulp.series('lib', 'tdd'));

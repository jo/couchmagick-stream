var couch = process.argv[2];

if (!couch) {
  return console.log('Please give me a database url!');
}

var stream = require('..');
var es = require('event-stream');
var request = require('request').defaults({ json: true });
var JSONStream = require('JSONStream');

// Generate a small image version for all images
// a medium scaled version for post images
// and a large version for header images.
var config = {
  small: {
    versions: {
      small: {
        args: [
          "-resize", "300x200",
          "-colorspace", "sRGB", // use sRGB color profile
          "-strip",              // strip meta data
          "png:-"                // generate png
        ]
      }
    }
  },
  sizes: {
    // only process post documents
    filter: function(doc) {
      return doc.type === 'post';
    },
    versions: {
      medium: {
        id: "{id}-{version}",
        name: "{basename}/{version}{extname}",
        args: [
          "-resize", "800x600",
          "-quality", "75",
          "-colorspace", "sRGB",
          "-strip"
        ]
      },
      large: {
        // large cropped version for header images
        filter: function(doc, name) {
          return name.match(/^header/);
        },
        id: "{id}-header",
        name: "header/large.jpg",
        args: [
          "-quality", "75",
          "-unsharp", "0",
          "-colorspace", "sRGB",
          "-interlace", "Plane",
          "-strip",
          "-density", "72",
          "-resize", "960x320^",
          "-gravity", "center",
          "-crop", "960x320+0+0", "+repage"
        ]
      }
    }
  }
};

var magick = es.pipeline(
  // get all docs
  request.get(couch + '/_all_docs', { qs: { include_docs: true } }),
  
  // parse response
  JSONStream.parse('rows.*'),

  // use two concurrent convert processes
  stream(couch, config, { concurrency: 2 }),
  
  // format output
  es.map(function map(data, done) {
    done(null, {
      code: data.code,
      file: data.target.id + '/' + data.target.name,
      rev: data.target.rev
    });
  }),
  
  es.stringify(),
  process.stdout
);
magick.on('error', console.error);

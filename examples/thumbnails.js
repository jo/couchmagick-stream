var couch = process.argv[2];

if (!couch) {
  return console.log('Please give me a database url!');
}

var stream = require('..');
var es = require('event-stream');
var request = require('request').defaults({ json: true });
var JSONStream = require('JSONStream');

// generate a thumbnail for all images
var config = {
  versions: {
    thumbnail: {
      args: [
        "-resize", "x100"
      ]
    }
  }
};

var magick = es.pipeline(
  request.get(couch + '/_all_docs', { qs: { include_docs: true } }),
  JSONStream.parse('rows.*'),
  stream(couch, { thumbnails: config }),
  es.stringify(),
  process.stdout
);
magick.on('error', console.error);

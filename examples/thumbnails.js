var couch = process.argv[2];

if (!couch) {
  return console.log('Please give me a database url!');
}

var stream = require('..');
var es = require('event-stream');
var request = require('request').defaults({ json: true });
var JSONStream = require('JSONStream');

var config = {
  filter: function(doc) {
    return doc.type === 'post';
  },
  versions: {
    thumbnail: {
      filter: function(doc, name) {
        return doc.display && doc.display.indexOf('overview') > -1;
      },
      format: "jpg",
      id: "{id}/thumbnail",
      name: "{basename}-thumbnail.jpg",
      args: [
        "-",
        "-resize", "x100",
        "-quality", "75",
        "-colorspace", "sRGB",
        "-strip",
        "jpg:-"
      ]
    }
  }
};

var magick = es.pipeline(
  request.get(couch + '/_all_docs', { qs: { include_docs: true } }),
  JSONStream.parse('rows.*'),
  stream(couch, config),
  es.map(function map(data, done) {
    done(null, data.response);
  }),
  es.stringify(),
  process.stdout
);
magick.on('error', console.error);

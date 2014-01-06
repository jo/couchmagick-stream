/* couchmagick-stream
 * (c) 2013 Johannes J. Schmidt, null2 GmbH, Berlin 
 */

var util = require('util');
var path = require('path');
var strformat = require('strformat');
var spawn = require('child_process').spawn;
var es = require('event-stream');
var nano = require('nano');

var noop = function() {};


// Decide whether a whole doc needs processing at all
function docFilter(doc) {
  if (!doc) {
    return false;
  }
  if (!doc._attachments) {
    return false;
  }

  var names = Object.keys(doc._attachments);
  if (!names.length) {
    return false;
  }

  return true;
}

// Decide if couchmagick should be run on a specific attachment
function attachmentFilter(doc, name) {
  if (!doc) {
    return false;
  }
  if (!name) {
    return false;
  }

  return doc._attachments[name].content_type.slice(0, 6) === 'image/';
}


module.exports = function couchmagick(url, config) {
  var db = nano(url);

  // TODO: validate config


  var pipeline = es.pipeline(
    // filter docs
    es.map(function map(data, done) {
      if (!docFilter(data.doc)) {
        return done();
      }

      if (typeof config.filter === 'function' && !config.filter(data.doc)) {
        return done();
      }

      done(null, data);
    }),

    // split stream into attachments
    es.through(function write(data) {
      var queue = this.queue;

      Object.keys(data.doc._attachments).forEach(function(name) {
        util._extend(data, {
          name: name
        });

        queue(data);
      });
    }),

    // filter attachments
    es.map(function map(data, done) {
      if (!attachmentFilter(data.doc, data.name)) {
        return done();
      }

      done(null, data);
    }),

    // split stream into versions
    // TODO: this prevents us from supporting multiple attachments per document
    // and therefore needs serialisation
    es.through(function write(data) {
      var queue = this.queue;

      Object.keys(config.versions).forEach(function(version) {
        var options = config.versions[version];

        // run version filter
        if (typeof options.filter === 'function' && !options.filter(data.doc)) {
          return;
        }

        // construct target doc
        var id = strformat(options.id, {
          id: data.doc._id
        });
        var name = strformat(options.name, {
          name: data.name,
          extname: path.extname(data.name),
          basename: path.basename(data.name, path.extname(data.name)),
          dirname: path.dirname(data.name)
        });

        util._extend(data, {
          source: {
            id: data.doc._id,
            name: data.name,
            revpos: data.doc._attachments[data.name].revpos,
            couchmagick: data.doc.couchmagick
          },
          args: options.args,
          target: {
            id: id,
            name: name,
            content_type: options.content_type
          }
        });

        queue(data);
      });
    }),


    // filter derived versions to prevent cascades
    // eg:
    //   single-attachment/thumbnail
    //   single-attachment/thumbnail/thumbnail
    //   single-attachment/thumbnail/thumbnail/thumbnail
    es.map(function map(data, done) {
      var derivative = data.source.couchmagick &&
        data.source.couchmagick[data.source.id] &&
        data.source.couchmagick[data.source.id][data.source.name] &&
        data.source.couchmagick[data.source.id][data.source.name].id;

      if (derivative) {
        done();
      }
      
      done(null, data);
    }),


    // get target doc
    es.map(function map(data, done) {
      var queue = this.queue;

      db.get(data.target.id, function(err, doc) {
        if (doc) {
          data.target.doc = doc;
        }

        done(null, data);
      });
    }),


    // store reference to source in target doc
    es.map(function map(data, done) {
      var queue = this.queue;

      data.target.doc = data.target.doc || { _id: data.target.id };
      data.target.doc.couchmagick = data.target.doc.couchmagick || {};
      data.target.doc.couchmagick[data.target.id] = data.target.doc.couchmagick[data.target.id] || {};
      data.target.doc.couchmagick[data.target.id][data.target.name] = {
        id: data.source.id,
        name: data.source.name,
        revpos: data.source.revpos
      };

      db.insert(data.target.doc, data.target.id, function(err, response) {
        if (!err && response.ok) {
          data.target.rev = response.rev;
        }

        done(null, data);
      });
    }),


    // process attachments
    es.map(function map(data, done) {
      var convert = spawn('convert', data.args);

      // emit convert errors
      convert.stderr.on('data', function(err) {
        done(err);
      });

      var params = data.target.rev ? { rev: data.target.rev } : null;

      es.pipeline(
        // request attachment
        db.attachment.get(data.source.id, data.source.name),

        // convert attachment
        es.duplex(convert.stdin, convert.stdout),

        // save attachment
        db.attachment
          .insert(data.target.id, data.target.name, null, data.target.content_type, params),

        // parse response
        es.parse()
    ).on('data', function(response) {
        data.response = response;
        done(null, data);
      })
    .on('end', function() {
        pipeline.emit('completed', data)
      });
    })
  );

  return pipeline;
};


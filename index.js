/* couchmagick-stream
 * (c) 2013 Johannes J. Schmidt, null2 GmbH, Berlin 
 */

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


// quick and dirty spawn queue
var last;
var queue = [];
function convert(args, callback) {
  if (!last) {
    last = spawn('convert', args);
    last.on('exit', function() {
      if (queue.length) {
        var a = queue.pop();
        last = spawn('convert', a[0]);
        a[1](last);
      }
    });

    return callback(last);
  }

  queue.push([args, callback]);
}


module.exports = function couchmagick(url, config) {
  var db = nano(url);

  // TODO: validate config


  // TODO: serialize:
  //   read, convert and write one attachment,
  //   than process the next one
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
        queue({
          doc: data.doc,
          name: name
        });
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

      Object.keys(config.versions).forEach(function(name) {
        var version = config.versions[name];

        // run version filter
        if (typeof version.filter === 'function' && !version.filter(data.doc)) {
          return;
        }

        // construct target doc
        var id = strformat(version.id, {
          id: data.doc._id,
          parts: data.doc._id.split('/'),
          version: name
        });
        var name = strformat(version.name, {
          id: data.doc._id,
          parts: data.doc._id.split('/'),
          version: name,

          name: data.name,
          extname: path.extname(data.name),
          basename: path.basename(data.name, path.extname(data.name)),
          dirname: path.dirname(data.name)
        });


        queue({
          source: {
            id: data.doc._id,
            name: data.name,
            revpos: data.doc._attachments[data.name].revpos,
            couchmagick: data.doc.couchmagick
          },
          args: version.args,
          target: {
            id: id,
            name: name,
            content_type: version.content_type
          }
        });
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
      db.get(data.target.id, function(err, doc) {
        if (doc) {
          data.target.doc = doc;
        }

        done(null, data);
      });
    }),


    // store reference to source in target doc
    es.map(function map(data, done) {
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
      convert(data.args, function(c) {
        // emit convert errors
        c.stderr.on('data', function(err) {
          done(err);
        });

        var params = data.target.rev ? { rev: data.target.rev } : null;

        var save = es.pipeline(
          // request attachment
          db.attachment.get(data.source.id, data.source.name),

          // convert attachment
          es.duplex(c.stdin, c.stdout),

          // save attachment
          db.attachment
            .insert(data.target.id, data.target.name, null, data.target.content_type, params),

          // parse response
          es.parse()
        );
        
        save.on('data', function(response) {
          data.response = response;

          done(null, data);
        });
        save.on('end', function() {
          pipeline.emit('completed', data);
        });
      });

      // var convert = spawn('convert', data.args);

    })
  );

  return pipeline;
};


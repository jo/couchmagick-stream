/* couchmagick-stream
 * (c) 2013 Johannes J. Schmidt, null2 GmbH, Berlin 
 */

var path = require('path');
var strformat = require('strformat');
var spawn = require('child_process').spawn;
var es = require('event-stream');
var nano = require('nano');
var async = require('async');

var noop = function() {};


// Decide whether a whole doc needs processing at all
function docFilter(doc) {
  if (!doc) {
    return false;
  }
  if (!doc._attachments) {
    return false;
  }

  if (!Object.keys(doc._attachments).length) {
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



module.exports = function couchmagick(url, configs, options) {
  var db = nano(url);

  // TODO: validate configs


  options = options || {};
  options.concurrency = options.concurrency || 1;


  // serialize processing
  var convert = async.queue(function(data, callback) {
    // get target doc
    db.get(data.target.id, function(err, doc) {
      // insert couchmagick stamp
      data.target.doc = doc || { _id: data.target.id };
      data.target.doc.couchmagick = data.target.doc.couchmagick || {};
      data.target.doc.couchmagick[data.target.id] = data.target.doc.couchmagick[data.target.id] || {};
      data.target.doc.couchmagick[data.target.id][data.target.name] = {
        id: data.source.id,
        name: data.source.name,
        revpos: data.source.revpos
      };


      // query params, doc_name is used by nano as id
      var params = {
        doc_name: data.target.id
      };
      if (data.target.doc._rev) {
        params.rev = data.target.doc._rev;
      }
      
      // attachment multipart part
      var attachment = {
        name: data.target.name,
        content_type: data.target.content_type,
        data: []
      };
      var cerror = [];

      // convert process
      var c = spawn('convert', data.args);
      // emit convert errors
      c.stderr.on('data', function(err) {
        cerror.push(err);
      });

      // collect convert output
      c.stdout.on('data', function(data) {
        attachment.data.push(data);
      });

      // concat convert output
      c.stdout.on('end', function() {
        attachment.data = Buffer.concat(attachment.data);
      });

      // convert process finish
      c.on('close', function(code) {
        // store exit code
        data.code = code;
        data.target.doc.couchmagick[data.target.id][data.target.name].code = data.code;

        if (code === 0) {
          // no error: make multipart request
          return db.multipart.insert(data.target.doc, [attachment], params, function(err, response) {
            if (err) {
              return callback(err);
            }

            data.response = response;
            if (response.rev) {
              data.target.rev = response.rev;
            }

            callback(null, data);
          });
        }
      
        // store error
        data.error = Buffer.concat(cerror).toString();
        data.target.doc.couchmagick[data.target.id][data.target.name].error = data.error;

        // store document stup, discard attachment
        db.insert(data.target.doc, data.target.id, function(err, response) {
          if (err) {
            return callback(err);
          }

          data.response = response;
          if (response.rev) {
            data.target.rev = response.rev;
          }

          callback(null, data);
        });
      });


      // request attachment and pipe it into convert process
      db.attachment.get(data.source.id, data.source.name).pipe(c.stdin);
    });
  }, options.concurrency);


  var pipeline = es.pipeline(
    // filter docs with builtin filter
    es.map(function map(data, done) {
      if (!docFilter(data.doc)) {
        return done();
      }

      done(null, data);
    }),

    // split stream into each config
    es.through(function write(data) {
      var queue = this.queue;

      Object.keys(configs).forEach(function(config) {
        queue({
          seq: data.seq,
          doc: data.doc,
          config: configs[config]
        });
      });
    }),

    // filter docs with config filter
    es.map(function map(data, done) {
      if (typeof data.config.filter === 'function' && !data.config.filter(data.doc)) {
        return done();
      }

      done(null, data);
    }),

    // split stream into attachments
    es.through(function write(data) {
      var queue = this.queue;

      Object.keys(data.doc._attachments).forEach(function(name) {
        queue({
          seq: data.seq,
          doc: data.doc,
          config: data.config,
          name: name
        });
      });
    }),

    // filter attachments with builtin
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

      Object.keys(data.config.versions).forEach(function(name) {
        var version = data.config.versions[name];

        // version defaults
        version.id   =         version.id           || '{id}/{version}';
        version.name =         version.name         || '{basename}-{version}{extname}';
        version.content_type = version.content_type || 'image/jpeg';
        version.args =         version.args         || [];

        // first arg is input pipe
        if (!version.args[0] || version.args[0] !== '-') {
          version.args.unshift('-');
        }
        // last arg is output pipe
        if (version.args.length < 2 || !version.args[version.args.length - 1].match(/^[a-z]{0,3}:-$/)) {
          version.args.push('jpg:-');
        }

        // run version filter
        if (typeof version.filter === 'function' && !version.filter(data.doc, data.name)) {
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
          seq: data.seq,
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
    //
    // TODO: do not process attachments twice, respect revpos
    es.map(function map(data, done) {
      var derivative = data.source.couchmagick &&
        data.source.couchmagick[data.source.id] &&
        data.source.couchmagick[data.source.id][data.source.name] &&
        data.source.couchmagick[data.source.id][data.source.name].id;

      if (derivative) {
        return done();
      }
      
      done(null, data);
    }),


    // process attachments
    es.map(function map(data, done) {
      pipeline.emit('started', data);

      convert.push(data, function(err, res) {
        pipeline.emit('completed', data);

        done(err, res);
      });
    })
  );


  return pipeline;
};


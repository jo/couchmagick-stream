couchmagick-stream
============
Pipe CouchDB documents through ImageMagicks convert.

# Deprication Warning
This is depricated in favor of [couchmagick](https://github.com/jo/couchmagick).

Usage
-----
```js
var stream = require('couchmagick-stream');
var es = require('event-stream');
var request = require('request').defaults({ json: true });

var couch = 'http://localhost:5984/mydb';
var config = {
  versions: {
    thumbnail: {
      args: [
        "-resize", "x100"
      ]
    }
  }
};

es.pipeline(
  request.get(couch + '/_all_docs', { qs: { include_docs: true } }),
  JSONStream.parse('rows.*'),
  stream(couch, { thumbs: config }),
  es.map(function map(data, done) {
    done(null, data.response);
  }),
  es.stringify(),
  process.stdout
);
```

See `examples/posts.js` for an advanced usage example.


### `filter`
There are two kinds of filters which you can define: one operates on doc level
and one on version level.

#### Document Filter
This filter is called with one argument: document.

#### Version Filter
This filter is called with two arguments, document and attachment name.

### `content_type`
Content-Type of the resulting attachment. Default is `image/jpeg`.

### `id`
The document id where the version is stored. Defaults to `{id}/{version}`.

Can have the following placeholders:
* `id` - the original doc id
* `parts` - array of the id splitted at `/`
* `version` - name of the version

### `name`
The attachment name of the version. Default is `{basename}-{version}{extname}`.

Can have placeholders:
* `id` - the original doc id
* `parts` - array of the id splitted at `/`
* `version` - name of the version
* `name` - original attachment name, eg `this/is/my-image.jpg`
* `extname` - file extenstion of the original attachment name, eg `.jpg`
* `basename` - basename without extension, eg `my-image`
* `dirname` - directory name, eg `this/is`
* `version` - name of the version

### `args`
Array of argument strings for ImageMagicks `convert`.

The default is `['-', 'jpg:-']`, which means that ImageMagick converts the image
to `jpg`. You can see that we use `convert` with pipes for in- and output.

See [ImageMagick Convert Command-line Tool](http://www.imagemagick.org/script/convert.php)
for a comprehensive list of options.

Options
-------
couchmagick-stream accepts an optional options object as third parameter:

* `concurrency` - Number of simultanous processes. Default is 1.
* `convert_process_timeout` - Timeout for `convert` process. Default is 1 minute.


Examples
--------

You can run an example (`examples/thumbnails.js`):
```bash
node examples/thumbnails.js http://localhost:5984/mydb
```

Contributing
------------
Lint your code with `npm run jshint`

(c) 2013 Johannes J. Schmidt, null2 GmbH

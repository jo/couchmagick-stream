couchmagick-stream
============
Pipe CouchDB documents through ImageMagicks convert.

Usage
-----
```js
var stream = require('couchmagick-stream');
var es = require('event-stream');
var request = require('request').defaults({ json: true });

var couch = 'http://localhost:5984/mydb';

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

es.pipeline(
  request.get(couch + '/_all_docs', { qs: { include_docs: true } }),
  JSONStream.parse('rows.*'),
  stream(couch, config),
  es.stringify(),
  process.stdout
);
```

Filters
-------
There are two kinds of filters which you can define: one operates on doc level
and one on attachment level. The latter are defined on a per variant level.

### Document Filter
This filter is called with one argument: document.

### Attachment Filter
This filter is called with two arguments, document and attachment name.


Placeholders
------------
`version.id` and `version.name` can have placeholders:

### `id`
* `id` - the original doc id

### `name`
* `name` - original attachment name, eg `this/is/my-image.jpg`
* `extname` - file extenstion of the original attachment name, eg `.jpg`
* `basename` - basename without extension, eg `my-image`
* `dirname` - directory name, eg `this/is`


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

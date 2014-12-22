var bucketManager = require('./lib/buckets.js'),
    xml = require('xml'),
    url = require('url'),
    crypto = require('crypto'),
    busboy = require('connect-busboy'),
    _ = require('lodash'),
    express = require('express'),
    app = express();

app.use(busboy());


// must be on top so it checks auth on all requests handlers declared after it.
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

    if (req.method === 'OPTIONS')
        return next();

    // TODO: would be nice to have a way to parse the form
    // fields at this point to do the authenication here,
    // but not parse the files, let the handler do that.
    // for now Auth is assumed it will be done in the POST handler
    if (req.method === 'POST')
        return next();

    var signer = new Signer(req);
    var auth = signer.getAuthorization({
        accessKeyId: 'key', // TODO: don't hard code these values
        secretAccessKey: 'secret'
    }, new Date());

    if (req.headers.authorization === auth) {
        return next();
    }

    return res.status(403).send(formulateError({
        code: 'Access Denied',
        message: 'Authorization failed'
    })).end();
});

/*********************
 * Object Operations *
 * *******************
 */

/**
 * deleteObject
 * ------------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#deleteObject-property
 */
app.delete('/*/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }
    bucketManager.onReady(function () {
        bucketManager.getBucket(info.bucket, function (err, bucket) {
            if (err)
                return res.status(403).send(formulateError({
                    code: 'Access Denied',
                    message: err.toString()
                })).end();
            bucket.deleteFile(info.key, function (err) {
                if (err)
                    return res.status(403).send(formulateError({
                        code: 'Access Denied',
                        message: err.toString()
                    })).end();

                res.status(200).end();
            });
        });
    });
});

/**
 * headObject
 * ----------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#headObject-property
 */
app.head('/*/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }
    bucketManager.onReady(function () {
        bucketManager.getBucket(info.bucket, function (err, bucket) {
            if (err)
                return res.status(403).send(formulateError({
                    code: 'Access Denied',
                    message: err.toString()
                })).end();

            bucket.getMD5Hash(info.key, function (err, md5) {
                if (err)
                    return res.status(403).send(formulateError({
                        code: 'Access Denied',
                        message: err.toString()
                    })).end();
                res.setHeader('ETag', '"' + md5 + '"');
                res.status(200).end();
            });
        });
    });
});

/**
 *  getObject
 *  ---------
 *  http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#getObject-property
 */
app.get('/*/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }
    bucketManager.onReady(function () {
        bucketManager.getBucket(info.bucket, function (err, bucket) {
            if (err)
                return res.status(403).send(formulateError({
                    code: 'Access Denied',
                    message: err.toString()
                })).end();
            bucket.getFile(decodeURIComponent(info.key), function (err, stream, stat) {
                if (err) {
                    var code = 'Error';
                    if (err.toString() === 'Error: 404: File not found.') {
                        code = 'NoSuchKey';
                        err = 'The specified key does not exist.';
                    }
                    return res.status(404).send(formulateError({
                        code: code,
                        message: err.toString()
                    })).end();
                }

                var url = require('url');
                var url_parts = url.parse(req.url, true);
                var query = url_parts.query;
                if (query['response-content-disposition'])
                    res.setHeader('Content-Disposition', query['response-content-disposition']);
                res.setHeader('content-type', stat.type);
                res.status(200);
                stream.pipe(res);
            });
        });
    });
});

/**
 * postObject ( for HTML forms )
 * -----------------------------
 * http://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPOST.html
 */
app.post('/*', function (req, res) {
    var info = parseUrl(req.url);
    var form = {};
    req.busboy.on('field', function(fieldname, val) {
        form[fieldname] = val;
    });

    var called = false;
    req.busboy.on('file', function(fieldname, file) {
        // only allow single file upload
        if (called)
            return;
        called = true;
        if (!allowed(_.extend(form, { bucket: info.bucket })))
            return res.status(403).send(formulateError({
                code: 'Access Denied',
                message: 'Authorization failed'
            })).end();

        bucketManager.onReady(function () {
            bucketManager.getBucket(info.bucket, function (err, bucket) {
                if (err)
                    return res.status(403).send(formulateError({
                        code: 'Access Denied',
                        message: err.toString()
                    })).end();

                bucket.insertFile(form.key, file, function (err, file) {
                    if (err)
                        return res.status(403).send(formulateError({
                            code: 'Access Denied',
                            message: err.toString()
                        })).end();
                    var fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
                    res.writeHead(204, {
                        etag: '"' + file.md5 + '"',
                        location: fullUrl + '/' + form.key
                    });
                    res.end();
                });
            });
        });
    });

    req.pipe(req.busboy);

    function allowed(info) {
        var s3Policy = require('s3policy');
        var myS3Account = new s3Policy(info.AWSAccessKeyId, 'secret');
        var p = myS3Account.writePolicy(info.key, info.bucket, 60, 10);
        return info.policy === p.s3PolicyBase64;
    }
});


/**
 * putObject
 * ---------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
 */
app.put('/*/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }
    bucketManager.onReady(function () {

        bucketManager.getBucket(info.bucket, function (err, bucket) {
            if (err)
                return res.status(403).send(formulateError({
                    code: 'Access Denied',
                    message: err.toString()
                })).end();

            bucket.insertFile(info.key, req, function (err, file) {
                if (err)
                    return res.status(403).send(formulateError({
                        code: 'Access Denied',
                        message: err.toString()
                    })).end();
                res.header('ETag', '"' + file.md5 + '"');
                res.status(200).end();
            });
        });
    });
});

/*********************
 * Bucket Operations *
 * *******************
 */

/**
 * listBuckets
 * -----------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listBuckets-property
 */
app.get('/', function (req, res) {
    var info = parseUrl(req.url);
    bucketManager.onReady(function () {
        bucketManager.listBuckets(function (err, buckets) {
            var x = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            xml({
                ListAllMyBucketsResult: [
                    { _attr: { xmlns: "http://s3.amazonaws.com/doc/2006-03-01/" } },
                    { Buckets: buckets.map(function (b) {
                        return {
                            Bucket: [{ Name: b.name}]
                        };
                    }) }
                ]
            });
            res.status(200).send(x).end();

        });
    });
});

/**
 * deleteBucket
 * ------------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#deleteBucket-property
 */
app.delete('/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }
    bucketManager.onReady(function () {
        bucketManager.deleteBucket(info.bucket, function (err) {
            if (err)
                return res.status(500).send(formulateError({
                    code: 'Error',
                    message: err.toString()
                })).end();
            res.status(200).end();
        });
    });
});

/**
 * createBucket
 * ------------
 * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#createBucket-property
 */
app.put('/*', function (req, res) {
    var info = parseUrl(req.url);
    res.set('Content-Type', 'text/xml');
    if (!info.bucket) {
        return res.status(403).send(formulateError({
            code: 'Access Denied',
            message: 'Bucket name required'
        })).end();
    }

    bucketManager.onReady(function () {
        bucketManager.createBucket(info.bucket, function (err/*, bucketId */) {
            if (err)
                return res.status(403).send(formulateError({
                    code: 'Access Denied',
                    message: err.toString()
                })).end();
            res.header('Location', '/' + info.bucket);
            res.status(200).end();
        });
    });
});

// Webs server setup
var port = process.env.PORT || 7000;
app.listen(port);

module.exports = app;

function formulateError(opts) {
    var html = "";
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        xml({
            Error: [
                { Code: opts.code },
                { Message: opts.message },
                { RequestId: 'not implemented' },
                { hostId: 'not implemented' }
            ]
        });
}

function parseUrl (url) {
    var domainRemoved = url
        .replace('s3.amazonaws.com', '')
        .replace(':443', '')
        .replace('http://', '')
        .replace('https://', '')
        .replace(/\?.*$/, '')
        .replace(/(^\/|\/$)/g, ''); // beginning or ending '/' chars

    var pieces = domainRemoved.split('/');
    return {
        bucket: decodeURIComponent(pieces[0]),
        key: decodeURIComponent(pieces[1])
    };
}


function Signer (req) {
    this.request = req;
}

_.extend(Signer.prototype, {
    /**
     * When building the stringToSign, these sub resource params should be
     * part of the canonical resource string with their NON-decoded values
     */
    subResources: {
        'acl': 1,
        'cors': 1,
        'lifecycle': 1,
        'delete': 1,
        'location': 1,
        'logging': 1,
        'notification': 1,
        'partNumber': 1,
        'policy': 1,
        'requestPayment': 1,
        'restore': 1,
        'tagging': 1,
        'torrent': 1,
        'uploadId': 1,
        'uploads': 1,
        'versionId': 1,
        'versioning': 1,
        'versions': 1,
        'website': 1
    },

    // when building the stringToSign, these querystring params should be
    // part of the canonical resource string with their NON-encoded values
    responseHeaders: {
        'response-content-type': 1,
        'response-content-language': 1,
        'response-expires': 1,
        'response-cache-control': 1,
        'response-content-disposition': 1,
        'response-content-encoding': 1
    },
    getAuthorization: function getAuthorization(credentials, date) {
        var signature = this.sign(credentials.secretAccessKey, this.stringToSign());
        return 'AWS ' + credentials.accessKeyId + ':' + signature;
    },
    sign: function sign(secret, string) {
        if (typeof string === 'string') string = new Buffer(string);
        return crypto.createHmac('sha1', secret).update(string).digest('base64');
    },

    stringToSign: function stringToSign() {
        var r = this.request;

        var parts = [];
        parts.push(r.method);
        parts.push(r.headers['content-md5'] || '');
        parts.push(r.headers['content-type'] || '');

        // This is the "Date" header, but we use X-Amz-Date.
        // The S3 signing mechanism requires us to pass an empty
        // string for this Date header regardless.
        parts.push(r.headers['presigned-expires'] || '');

        var headers = this.canonicalizedAmzHeaders();
        if (headers) parts.push(headers);
        parts.push(this.canonicalizedResource());

        return parts.join('\n');

    },

    canonicalizedAmzHeaders: function canonicalizedAmzHeaders() {

        var amzHeaders = [];

        _.each(Object.keys(this.request.headers), function (name) {
            if (name.match(/^x-amz-/i))
                amzHeaders.push(name);
        });

        amzHeaders.sort(function (a, b) {
            return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
        });

        var parts = [];
        arrayEach.call(this, amzHeaders, function (name) {
            parts.push(name.toLowerCase() + ':' + String(this.request.headers[name]));
        });

        return parts.join('\n');

    },

    canonicalizedResource: function canonicalizedResource() {

        var r = this.request;

        var parts = r.path.split('?');
        var path = parts[0];
        var querystring = parts[1];

        var resource = '';

        if (r.virtualHostedBucket)
            resource += '/' + r.virtualHostedBucket;

        resource += path;

        if (querystring) {

            // collect a list of sub resources and query params that need to be signed
            var resources = [];

            arrayEach.call(this, querystring.split('&'), function (param) {
                var name = param.split('=')[0];
                var value = param.split('=')[1];
                if (this.subResources[name] || this.responseHeaders[name]) {
                    var subresource = { name: name };
                    if (value !== undefined) {
                        if (this.subResources[name]) {
                            subresource.value = value;
                        } else {
                            subresource.value = decodeURIComponent(value);
                        }
                    }
                    resources.push(subresource);
                }
            });

            resources.sort(function (a, b) { return a.name < b.name ? -1 : 1; });

            if (resources.length) {

                querystring = [];
                _.each(resources, function (resource) {
                    if (resource.value === undefined)
                        querystring.push(resource.name);
                    else
                        querystring.push(resource.name + '=' + resource.value);
                });

                resource += '?' + querystring.join('&');
            }

        }

        return resource;

    }
});

function arrayEach(array, iterFunction) {
    for (var idx in array) {
        if (array.hasOwnProperty(idx)) {
            var ret = iterFunction.call(this, array[idx], parseInt(idx, 10));
        }
    }
}
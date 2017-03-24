/////////////////////////////////////////////////////////////////////
// Copyright (c) Autodesk, Inc. All rights reserved
// Written by Forge Partner Development
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
/////////////////////////////////////////////////////////////////////

'use strict'; // http://www.w3schools.com/js/js_strict.asp

// token handling in session
var token = require('./token');

// web framework
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
var jsonParser = bodyParser.json();

// config information, such as client ID and secret
var config = require('./config');

// forge
var forgeSDK = require('forge-apis');

var request = require('request');

// Google API
var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var oauth2Client = new OAuth2(config.google.credentials.client_id, config.google.credentials.client_secret, config.google.callbackURL);


function respondWithError(res, error) {
  if (error.statusCode) {
    res.status(error.statusCode).end(error.statusMessage);
  } else {
    res.status(500).end(error.message);
  }
}

router.post('/integration/sendToGDrive', jsonParser, function (req, res) {
  var tokenSession = new token(req.session);
  if (!tokenSession.isAuthorized()) {
    res.status(401).json({error: 'Please login first'});
    return;
  }

  // file IDs to transfer
  var autodeskFileId = decodeURIComponent(req.body.autodeskfile);
  var gdriveFolderId = req.body.gdrivefolder;

  // the autodesk file id parameters should be in the form of
  // /data/v1/projects/::project_id::/versions/::version_id::
  var params = autodeskFileId.split('/');
  var projectId = params[params.length - 3];
  var versionId = params[params.length - 1];

  var versions = new forgeSDK.VersionsApi();
  versions.getVersion(projectId, versionId, tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
    .then(function (version) {
      if (!version.body.data.relationships.storage || !version.body.data.relationships.storage.meta.link.href) {
        res.status(500).json({error: 'No storage defined, cannot transfer.'});
        return;
      }
      var storageLocation = version.body.data.relationships.storage.meta.link.href;
      // the storage location should be in the form of
      // /oss/v2/buckets/::bucketKey::/objects/::objectName::
      params = storageLocation.split('/');
      var bucketKey = params[params.length - 3];
      var objectName = params[params.length - 1];

      //var objects = new forgeOSS.ObjectsApi();
      // npm forge-oss call to download not working
      //objects.getObject(bucketKey, objectName).then(function (file) {

      // workaround to download
      request({
        url: storageLocation,
        method: "GET",
        headers: {
          'Authorization': 'Bearer ' + tokenSession.getInternalCredentials().access_token
        },
        encoding: null
      }, function (error, response, file) {
        if (error) {
          console.log(error);
          respondWithError(res, error);
          return;
        }
        // end of workaround

        var fileName = version.body.data.attributes.name;
        request.post({
          'url': 'https://www.googleapis.com/upload/drive/v2/files',
          'qs': {
            'uploadType': 'multipart'
          },
          'headers': {
            'Authorization': 'Bearer ' + tokenSession.getGoogleToken(),
          },
          'multipart': [
            {
              'Content-Type': 'application/json; charset=UTF-8',
              'body': JSON.stringify({
                'title': fileName,
                'parents': [
                  {
                    'id': gdriveFolderId
                  }
                ]
              })
            },
            {
              'Content-Type': 'octet/stream',
              'body': file
            }
          ]
        }, function (err, body, callback) {
          res.json({result: "OK", file: fileName});
        });
      });
    })
    .catch(function (err) {
      respondWithError(res, err);
    });
});

router.post('/integration/sendToAutodesk', jsonParser, function (req, res) {
  var tokenSession = new token(req.session);
  if (!tokenSession.isAuthorized()) {
    res.status(401).json({error: 'Please login first'});
    return;
  }

  // file IDs to transfer
  var autodeskType = req.body.autodesktype; // projects or folders
  var autodeskId = decodeURIComponent(req.body.autodeskid);
  var gdrivefileid = req.body.gdrivefileid;

  var projectId;
  var folderId;
  var params = autodeskId.split('/');
  switch (autodeskType) {
    case "folders":
      projectId = params[params.length - 3];
      folderId = params[params.length - 1];
      sendToAutodesk(projectId, folderId, gdrivefileid, res, req);
      break;
    case "projects":
      projectId = params[params.length - 1];
      var hubId = params[params.length - 3];
      var projects = new forgeSDK.ProjectsApi();
      projects.getProject(hubId, projectId,
        tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
        .then(function (project) {
          folderId = project.body.data.relationships.rootFolder.data.id;
          sendToAutodesk(projectId, folderId, gdrivefileid, res, req);
        });
      break;
  }
});

function uploadFile(projectId, folderId, fileName, fileSize, fileData, req) {
  return new Promise(function (_resolve, _reject) {
    try {
      // Ask for storage for the new file we want to upload
      var tokenSession = new token(req.session);
      var projects = new forgeSDK.ProjectsApi();
      projects.postStorage(projectId, JSON.stringify(storageSpecData(fileName, folderId)),
        tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
        .then(function (storageData) {
          var objectId = storageData.body.data.id;
          var bucketKeyObjectName = getBucketKeyObjectName(objectId);

          // Upload the new file
          var objects = new forgeSDK.ObjectsApi();
          objects.uploadObject(
            bucketKeyObjectName.bucketKey, bucketKeyObjectName.objectName, fileSize, fileData,
            {}, tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
            .then(function (objectData) {
              console.log('uploadObject: succeeded');
              _resolve(objectData.body.objectId);
            })
            .catch(function (error) {
              console.log('uploadObject: failed');
              _reject(error);
            });

        })
        .catch(function (error) {
          _reject(error);
        });
    } catch (err) {
      _reject(err);
    }
  });
}

function withoutExtension(fileName) {
  // Remove the last ".<extension>"
  // e.g.:
  // my.file.jpg >> my.file
  // myfile >> myfile
  return fileName.replace(/(.*)\.(.*?)$/, "$1");
}

function createNewItemOrVersion(projectId, folderId, fileName, objectId, req) {
  return new Promise(function (_resolve, _reject) {
    try {
      var tokenSession = new token(req.session);

      var folders = new forgeSDK.FoldersApi();
      folders.getFolderContents(projectId, folderId, {},
        tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
        .then(function (folderData) {
          var item = null;
          for (var key in folderData.body.data) {
            item = folderData.body.data[key];
            if (item.attributes.displayName === fileName || item.attributes.displayName === withoutExtension(fileName)) {
              break;
            } else {
              item = null;
            }
          }

          if (item) {
            // We found it so we should create a new version
            var versions = new forgeSDK.VersionsApi();
            var body = JSON.stringify(versionSpecData(fileName, projectId, item.id, objectId));
            versions.postVersion(projectId, body,
              tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
              .then(function (versionData) {
                _resolve(versionData.body.data.id);
              })
              .catch(function (error) {
                console.log('postVersion: failed');

                _reject(error);
              });
          } else {
            // We did not find it so we should create it
            var items = new forgeSDK.ItemsApi();
            var body = JSON.stringify(itemSpecData(fileName, projectId, folderId, objectId));
            items.postItem(projectId, body,
              tokenSession.getInternalOAuth(), tokenSession.getInternalCredentials())
              .then(function (itemData) {
                // Get the versionId out of the reply
                _resolve(itemData.body.included[0].id);
              })
              .catch(function (error) {
                console.log('postItem: failed');

                _reject(error);
              });
          }
        })
        .catch(function (error) {
          console.log('getFolderContents: failed');
          _reject(error);
        });
    } catch (err) {
      _reject(err);
    }
  });
}

function sendToAutodesk(projectId, folderId, googleFileId, res, req) {
  var tokenSession = new token(req.session);

  oauth2Client.setCredentials({
    access_token: tokenSession.getGoogleToken()
  });
  var drive = google.drive({version: 'v2', auth: oauth2Client});

  drive.files.get({
    fileId: googleFileId
  }, function (err, fileInfo) {
    var fileName = fileInfo.title;
    var fileSize = fileInfo.fileSize;

    request({
      url: 'https://www.googleapis.com/drive/v2/files/' + googleFileId + '?alt=media',
      method: "GET",
      headers: {
        'Authorization': 'Bearer ' + tokenSession.getGoogleToken(),
      },
      encoding: null
    }, function (error, response, filestream) {
      if (error != null) {
        console.log(error); // connection problems

        if (body.errors != null)
          console.log(body.errors);

        respondWithError(res, error);

        return;
      }

      try {
        uploadFile(projectId, folderId, fileName, fileSize, filestream, req)
          .then(function (objectId) {
            createNewItemOrVersion(projectId, folderId, fileName, objectId, req)
              .then(function (versionId) {
                var str = "";
                res.json({result: "OK", file: fileName});
              })
              .catch(function (error) {
                var str = "";
                respondWithError(res, error);
              });
          })
          .catch(function (error) {
            respondWithError(res, error);
          });
      } catch (err) {
        respondWithError(res, err);
      }
    });
  });
}

function getBucketKeyObjectName(objectId) {
  // the objectId comes in the form of
  // urn:adsk.objects:os.object:BUCKET_KEY/OBJECT_NAME
  var objectIdParams = objectId.split('/');
  var objectNameValue = objectIdParams[objectIdParams.length - 1];
  // then split again by :
  var bucketKeyParams = objectIdParams[objectIdParams.length - 2].split(':');
  // and get the BucketKey
  var bucketKeyValue = bucketKeyParams[bucketKeyParams.length - 1];

  var ret = {
    bucketKey: bucketKeyValue,
    objectName: objectNameValue
  };

  return ret;
}

function storageSpecData(fileName, folderId) {
  var storageSpecs = {
    data: {
      type: 'objects',
      attributes: {
        name: fileName
      },
      relationships: {
        target: {
          data: {
            type: 'folders',
            id: folderId
          }
        }
      }
    }
  };

  return storageSpecs;
}

function itemSpecData(fileName, projectId, folderId, objectId) {
  var itemsType = projectId.startsWith("a.") ? "items:autodesk.core:File" : "items:autodesk.bim360:File";
  var versionsType = projectId.startsWith("a.") ? "versions:autodesk.core:File" : "versions:autodesk.bim360:File";
  var itemSpec = {
    jsonapi: {
      version: "1.0"
    },
    data: {
      type: "items",
      attributes: {
        displayName: fileName,
        extension: {
          type: itemsType,
          version: "1.0"
        }
      },
      relationships: {
        tip: {
          data: {
            type: "versions",
            id: "1"
          }
        },
        parent: {
          data: {
            type: "folders",
            id: folderId
          }
        }
      }
    },
    included: [{
      type: "versions",
      id: "1",
      attributes: {
        name: fileName,
        extension: {
          type: versionsType,
          version: "1.0"
        }
      },
      relationships: {
        storage: {
          data: {
            type: "objects",
            id: objectId
          }
        }
      }
    }]
  };

  if (fileName.endsWith(".iam.zip")) {
    itemSpec.data[0].attributes.extension.type = "versions:autodesk.a360:CompositeDesign";
    itemSpec.data[0].attributes.name = fileName.slice(0, -4);
    itemSpec.included[0].attributes.name = fileName.slice(0, -4);
  }

  console.log(itemSpec);

  return itemSpec;
}

function versionSpecData(fileName, projectId, itemId, objectId) {
  var versionsType = projectId.startsWith("a.") ? "versions:autodesk.core:File" : "versions:autodesk.bim360:File";

  var versionSpec = {
    "jsonapi": {
      "version": "1.0"
    },
    "data": {
      "type": "versions",
      "attributes": {
        "name": fileName,
        "extension": {
          "type": versionsType,
          "version": "1.0"
        }
      },
      "relationships": {
        "item": {
          "data": {
            "type": "items",
            "id": itemId
          }
        },
        "storage": {
          "data": {
            "type": "objects",
            "id": objectId
          }
        }
      }
    }
  }

  if (fileName.endsWith(".iam.zip")) {
    versionSpec.data.attributes.extension.type = "versions:autodesk.a360:CompositeDesign";
    versionSpec.data.attributes.name = fileName.slice(0, -4);
  }

  console.log(versionSpec);

  return versionSpec;
}

function getMineType(fileName) {
  var re = /(?:\.([^.]+))?$/; // regex to extract file extension
  var extension = re.exec(fileName)[1];
  var types = {
    'png': 'application/image',
    'jpg': 'application/image',
    'txt': 'application/txt',
    'ipt': 'application/vnd.autodesk.inventor.part',
    'iam': 'application/vnd.autodesk.inventor.assembly',
    'dwf': 'application/vnd.autodesk.autocad.dwf',
    'dwg': 'application/vnd.autodesk.autocad.dwg',
    'f3d': 'application/vnd.autodesk.fusion360',
    'f2d': 'application/vnd.autodesk.fusiondoc',
    'rvt': 'application/vnd.autodesk.revit'
  };

  return (types[extension] != null ? types[extension] : 'application/' + extension);
}

module.exports = router;
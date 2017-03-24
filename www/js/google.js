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

$(document).ready(function () {
  var auth = isGoogleAuthorized();
  if (!isGoogleAuthorized()) {
    $('#refreshGoogleDriveTree').hide();
    $('#loginGoogle').click(googleSignIn);
  }
  else {
    $('#loginGoogle').hide();
    $('#refreshGoogleDriveTree').show();
    $('#refreshGoogleDriveTree').click(function () {
      $('#myGoogleDriveFiles').jstree(true).refresh();
    });
    prepareGoogleTree();
  }
});

function googleSignIn() {
  jQuery.ajax({
    url: '/google/authenticate',
    success: function (rootUrl) {
      location.href = rootUrl;
    }
  });
}

function isGoogleAuthorized() {
  var ret = 'false';
  jQuery.ajax({
    url: '/google/isAuthorized',
    success: function (res) {
      ret = res;
    },
    async: false // this request must be synchronous for the Forge Viewer
  });
  return (ret === 'true');
}

function prepareGoogleTree() {
  $('#myGoogleDriveFiles').jstree({
    'core': {
      'themes': {"icons": true},
      'data': {
        "url": '/google/getTreeNode',
        "dataType": "json",
        'multiple': false,
        "data": function (node) {
          return {"id": node.id};
        }
      }
    },
    // types must be defined in order to work with custom menus
    'types': {
      'default': {},
      'folder' : {},
      'vnd.google-apps.folder': {},
      'octet-stream':  {},
      'image/jpeg': {},
      'pdf': {}
    },
    "plugins": ["types", "state", "sort", "contextmenu"],
    contextmenu: {items: googleCustomMenu}
  }).bind("activate_node.jstree", function (evt, data) {
    if (data != null && data.node != null) {
      //translateFile(data.node);
    }
  });
}

function translateFile(googleNode) {
  var extension = (re.exec(googleNode.text)[1]);
  if (!extension) {
    $.notify('Sorry, we cannot view files without extension', 'warn');
    return;
  }

  isFileSupported(googleNode.text, function (supported) {
    if (!supported) {
      $.notify('File "' + googleNode.text + '" cannot be viewed, format not supported.', 'warn');
      return;
    }

    $.notify('Preparing to view "' + googleNode.text + '", please wait...', 'info');

    jQuery.ajax({
      url: '/integration/sendToTranslation',
      contentType: 'application/json',
      type: 'POST',
      dataType: 'json',
      data: JSON.stringify({
        'googlefile': googleNode.id
      }),
      success: function (res) {
        $.notify(res.status + (res.readyToShow ? ' Launching viewer.' : ''), 'info');
        if (res.readyToShow)
          launchViewer('forgeViewer', res.urn); // ready to show! launch viewer
        else
          wait(res.urn); // not ready to show... wait 5 seconds
      },
      error: function (res) {
        res = JSON.parse(res.responseText);
        $.notify(res.error, 'error');
      }
    });

  });
}

function wait(urn) {
  setTimeout(function () {
    jQuery.ajax({
      url: '/integration/isReadyToShow',
      contentType: 'application/json',
      type: 'POST',
      dataType: 'json',
      data: JSON.stringify({
        'urn': urn
      }),
      success: function (res) {
        if (res.readyToShow) {
          $.notify('Ready! Launching viewer.', 'info');
          launchViewer('forgeViewer', res.urn);
        }
        else {
          $.notify(res.status, 'warn');
          wait(res.urn);
        }
      },
      error: function (res) {
        res = JSON.parse(res.responseText);
        $.notify(res.error, 'error');
      }
    });
  }, 5000);
}

function googleCustomMenu(googleNode) {
  var items;

  switch (googleNode.type) {
    case 'octet-stream': case 'image/jpeg': case 'pdf':
      items = {
        renameItem: {
          label: "Send to Autodesk",
          icon: "/img/autodesk-forge.png",
          action: function () {
            var autodeskNode = $('#myAutodeskFiles').jstree(true).get_selected(true)[0];
            sendToAutodesk(googleNode, autodeskNode);
          }
        }
      };
      break
  }
  return items;
}

function sendToAutodesk(driveNode, autodeskNode) {
  if (autodeskNode == null || (autodeskNode.type != 'projects' && autodeskNode.type != 'folders')) {
    $.notify('Please select a Project or Folder on Autodesk', 'error');
    return;
  }

  $.notify('Preparing to send file "' + driveNode.text + '" to "' + autodeskNode.text + '" ' + autodeskNode.type, 'info');

  jQuery.ajax({
    url: '/integration/sendToAutodesk',
    contentType: 'application/json',
    type: 'POST',
    dataType: 'json',
    data: JSON.stringify({
      'autodesktype': autodeskNode.type, // projects or folders
      'autodeskid': autodeskNode.id,
      'gdrivefileid': driveNode.id
    }),
    success: function (res) {
      $.notify('Transfer of file "' + res.file + '" completed', 'info');
      $('#myAutodeskFiles').jstree(true).refresh_node(autodeskNode);
    },
    error: function (res) {
      res = JSON.parse(res.responseText);
      $.notify(res.error, 'error');
    }
  });
}

var re = /(?:\.([^.]+))?$/; // regex to extract file extension

function isFileSupported(fileName, callback) {
  var extension = (re.exec(fileName)[1]).toLowerCase();
  jQuery.ajax({
    url: '/md/viewerFormats',
    contentType: 'application/json',
    type: 'GET',
    dataType: 'json',
    success: function (supportedFormats) {
      // for a zip we need to define the rootFilename, need extra work (WIP)
      // let's remove it from the supported formats, for now
      supportedFormats.splice(supportedFormats.indexOf('zip'), 1);
      var supported = ( jQuery.inArray(extension, supportedFormats) >= 0);
      callback(supported);
    },
    error: function (res) {
      res = JSON.parse(res.responseText);
      $.notify(res.error, 'error');
    }
  });
}
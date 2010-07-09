Components.utils.import("resource://gre/modules/AddonManager.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;

const NS_XHTML = "http://www.w3.org/1999/xhtml";

var gDBStarted = false;
var gRootURI = null;

XPCOMUtils.defineLazyGetter(this, "ScriptDB", function() {
  try {
    var loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].
                 getService(Ci.mozIJSSubScriptLoader);
    var scope = {};
    loader.loadSubScript(gRootURI.spec + "includes/scriptdb.js", scope);
    gDBStarted = true;
    return scope.ScriptDatabase;
  }
  catch (e) {
    LOGE("Exception loading database", e);
  }
});

function LOG(aStr) {
  dump("SLMNKY: " + aStr + "\n");
}

function LOGE(aStr, aException) {
  dump("SLMNKY: " + aStr + ": " + aException + "\n");
  if ("stack" in aException)
    dump(aException.stack);
}

function getManagerStyles() {
  return "#category-scripts > .category-icon,\
          .addon[type=user-script] .icon,\
          #detail-view[type=user-script] #detail-icon {\
            list-style-image: url(" + gRootURI.spec + "images/script.png)\
          }";
}

function ExtendedStringBundle(aBase) {
  this.basebundle = aBase;
  this.strings = {};
}

ExtendedStringBundle.prototype = {
  strings: null,
  basebundle: null,

  GetStringFromName: function(aName) {
    if (aName in this.strings)
      return this.strings[aName];
    return this.basebundle.GetStringFromName(aName);
  },

  formatStringFromName: function(aName, aArgs, aLength) {
    return this.basebundle.formatStringFromName(aName, aArgs, aLength);
  }
};

var WindowObserver = {
  addToAddonsManager: function(aWindow) {
    var window = aWindow.wrappedJSObject;

    try {
      var bundle = new ExtendedStringBundle(window.gStrings.ext);
      bundle.strings["header-user-script"] = "User Scripts";
      window.gStrings.ext = bundle;

      var plugins = window.document.getElementById("category-plugins");
      var scripts = window.document.createElement("richlistitem");
      scripts.setAttribute("id", "category-scripts");
      scripts.setAttribute("value", "addons://list/user-script");
      scripts.setAttribute("class", "category");
      scripts.setAttribute("name", "User Scripts");
      plugins.parentNode.insertBefore(scripts, plugins);

      var styles = window.document.createElementNS(NS_XHTML, "style");
      styles.setAttribute("id", "script-styles");
      styles.setAttribute("type", "text/css");
      styles.appendChild(window.document.createTextNode(getManagerStyles()));
      window.document.documentElement.appendChild(styles);
    }
    catch (e) {
      LOGE("Exception in injectIntoAddonsManager", e);
    }
  },

  findAllAddonsManagers: function() {
    var managers = [];
    var windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      var window = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
      window.gBrowser.browsers.forEach(function(aBrowser) {
        if (aBrowser.currentURI.spec == "about:addons")
          managers.push(aBrowser.contentWindow);
      });
    }
    return managers;
  },

  addToAddonsManagers: function() {
    var managers = this.findAllAddonsManagers();
    managers.forEach(function(aWindow) {
      this.addToAddonsManager(aWindow);
    }, this);
  },

  removeFromAddonsManagers: function() {
    var managers = this.findAllAddonsManagers();
    managers.forEach(function(aWindow) {
      var window = aWindow.wrappedJSObject;
      var scripts = window.document.getElementById("category-scripts");
      scripts.parentNode.removeChild(scripts);
      var styles = window.document.getElementById("script-styles");
      styles.parentNode.removeChild(styles);
      window.gStrings.ext = window.gStrings.ext.basebundle;
    });
  },

  installPrompt: function(aWindow) {
    var window = aWindow.wrappedJSObject;

    window.addEventListener("load", function() {
      if (!Services.prompt.confirm(window, "Install Script?", "Do you want to install this user script?"))
        return;

      ScriptDB.installScript(window.document.body.textContent,
                             aWindow.document.documentURIObject);
    }, false);
  },

  injectScripts: function(aWindow, aScripts) {
    var safeWin = new XPCNativeWrapper(aWindow.wrappedJSObject);

    aScripts.forEach(function(aScript) {
      LOG("Injecting " + aScript.name);
      var sandbox = new Components.utils.Sandbox(safeWin);
      sandbox.window = safeWin;
      sandbox.document = sandbox.window.document;
      sandbox.unsafeWindow = aWindow.wrappedJSObject;
      sandbox.__proto__ = safeWin;

      var code = "(function(){" + aScript.script + "})()";

      try {
        Components.utils.evalInSandbox(code, sandbox, "1.8");
      }
      catch(e) {
        LOGE("Exception in injected script", e);
      }
    });
  },

  observe: function(aSubject, aTopic, aData) {
    try {
      var window = aSubject;
      var uri = window.document.documentURIObject;
      switch (aTopic) {
      case "content-document-global-created":
        LOG("Content window loaded: " + uri.spec);
        var scripts = ScriptDB.getScriptsForURI(uri);
        if (scripts.length > 0) {
          window.addEventListener("DOMContentLoaded", function() {
            WindowObserver.injectScripts(window, scripts);
          }, false);
        }
        if (uri.spec.substring(uri.spec.length - 8) == ".user.js" &&
            !ScriptDB.hasScript(uri))
          this.installPrompt(window);
        break;
      case "chrome-document-global-created":
        LOG("Chrome window loaded: " + uri.spec);
        if (uri.spec == "about:addons") {
          window.addEventListener("load", function() {
            WindowObserver.addToAddonsManager(window);
          }, false);
        }
        break;
      }
    }
    catch (e) {
      LOGE("Exception in observe", e);
    }
  }
};

var AddonProvider = {
  getAddonByID: function(aId, aCallback) {
    aCallback(ScriptDB.getScript(aId));
  },

  getAddonsByTypes: function(aTypes, aCallback) {
    if (aTypes && aTypes.indexOf("user-script") < 0)
      aCallback([]);
    else
      aCallback(ScriptDB.getAllScripts());
  }
};

function startup(aParams) {
  LOG("startup");

  try {
    gRootURI = Services.io.newFileURI(aParams.installPath);
    Services.obs.addObserver(WindowObserver, "content-document-global-created", false);
    Services.obs.addObserver(WindowObserver, "chrome-document-global-created", false);
    AddonManagerPrivate.registerProvider(AddonProvider);

    WindowObserver.addToAddonsManagers();
  }
  catch (e) {
    LOGE("Exception during startup", e);
  }
}

function shutdown() {
  LOG("shutdown");

  try {
    WindowObserver.removeFromAddonsManagers();

    AddonManagerPrivate.unregisterProvider(AddonProvider);
    Services.obs.removeObserver(WindowObserver, "content-document-global-created");
    Services.obs.removeObserver(WindowObserver, "chrome-document-global-created");

    if (gDBStarted)
      ScriptDB.shutdown();
  }
  catch (e) {
    LOGE("Exception during shutdown", e);
  }
}

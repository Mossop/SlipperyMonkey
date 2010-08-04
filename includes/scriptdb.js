const DB_SCHEMA = 1;
const ID_SUFFIX = "@slipperymonkey.fractalbrew.com";

var TAGMATCH = /^.*@(\S+)\s*(.*)/

var ScriptDatabase = {
  db: null,

  startup: function() {
    var dbfile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    dbfile.append("slippery.sqlite");
    this.db = Services.storage.openUnsharedDatabase(dbfile);
    if (this.db.schemaVersion < DB_SCHEMA)
      this.initDatabase();
  },

  initDatabase: function() {
    this.db.createTable("script",
                        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                        "name TEXT," +
                        "version TEXT," +
                        "author TEXT," +
                        "description TEXT," +
                        "uri TEXT," +
                        "enabled INTEGER," +
                        "script TEXT");
    this.db.createTable("include",
                        "script_id INTEGER," +
                        "address TEXT");

    this.db.executeSimpleSQL("CREATE TRIGGER delete_script AFTER DELETE ON script BEGIN " +
        "DELETE FROM include WHERE script_id=old.id; " +
      "END");
    this.db.schemaVersion = DB_SCHEMA;
  },

  getScript: function(aId) {
    if (aId.substring(aId.length - ID_SUFFIX.length) != ID_SUFFIX)
      return null;

    var stmt = this.db.createStatement("SELECT id, name, version, author, description, uri, enabled, script FROM script WHERE id=:id");
    stmt.params.id = aId.substring(0, aId.length - ID_SUFFIX.length);
    if (stmt.executeStep())
      return new Script(stmt.row);
    return null;
  },

  getAllScripts: function() {
    var scripts = [];

    var stmt = this.db.createStatement("SELECT id, name, version, author, description, uri, enabled, script FROM script");
    while (stmt.executeStep())
      scripts.push(new Script(stmt.row));
    return scripts;
  },

  getScriptsForURI: function(aURI) {
    var scripts = [];

    var stmt = this.db.createStatement("SELECT DISTINCT id, name, version, author, description, uri, enabled, script FROM script JOIN include ON script.id=include.script_id WHERE :uri GLOB address AND enabled=1");
    stmt.params.uri = aURI.spec;
    while (stmt.executeStep())
      scripts.push(new Script(stmt.row));
    return scripts;
  },

  hasScript: function(aURI) {
    var stmt = this.db.createStatement("SELECT COUNT() AS count FROM script WHERE uri=:uri");
    stmt.params.uri = aURI.spec;

    if (stmt.executeStep())
      return stmt.row.count > 0;
    return false;
  },

  installScript: function(aScript, aURI) {
    try {
      var data = {
        name: "",
        author: "",
        description: "",
        uri: aURI.spec,
        enabled: 1,
        script: aScript
      };
      var includes = [];
      var stmt = this.db.createStatement("INSERT INTO script VALUES (NULL, :name, :version, :author, :description, :uri, :enabled, :script)");
      stmt.params.uri = aURI.spec;
      stmt.params.enabled = 1;
      stmt.params.script = aScript;

      var start = aScript.indexOf("==UserScript==");
      var end = aScript.indexOf("==/UserScript==");
      if (start < 0 || end < 0)
        return;

      LOG("Looking for tags in " + aScript.substring(start, end));
      var lines = aScript.substring(start, end).split("\n");
      var pos = 0;
      while (pos < lines.length) {
        var matches = TAGMATCH.exec(lines[pos]);
        if (matches) {
          LOG("Tag: " + matches[1] + " = " + matches[2]);
          switch (matches[1]) {
          case "name":
          case "description":
          case "author":
          case "version":
            stmt.params[matches[1]] = matches[2];
            data[matches[1]] = matches[2];
            break;
          case "include":
            includes.push(matches[2]);
            break;
          }
        }
        pos++;
      }

      stmt.execute();
      var id = this.db.lastInsertRowID;

      stmt = this.db.createStatement("INSERT INTO include VALUES (:id, :address)");
      includes.forEach(function(aInclude) {
        stmt.params.id = id;
        stmt.params.address = aInclude;
        stmt.execute();
      });

      AddonManagerPrivate.callInstallListeners("onExternalInstall", null,
                                                new Script(data), null, false);
    }
    catch (e) {
      LOGE("Exception installing script", e);
    }
  },

  uninstallScript: function(aScript) {
    AddonManagerPrivate.callAddonListeners("onUninstalling", aScript, false);
    var stmt = this.db.createStatement("DELETE FROM script WHERE id=:id");
    stmt.params.id = aScript._id;
    stmt.execute();
    AddonManagerPrivate.callAddonListeners("onUninstalled", aScript);
  },

  updateDisabledState: function(aScript) {
    var stmt = this.db.createStatement("UPDATE script SET enabled=:enabled WHERE id=:id");
    stmt.params.id = aScript._id;
    stmt.params.enabled = aScript.enabled;
    stmt.execute();
  },

  shutdown: function() {
    this.db.asyncClose();
  }
};

function Script(aData) {
  this.id = aData.id + ID_SUFFIX;
  this._id = aData.id;
  this.name = aData.name;
  this.version = aData.version;
  this.creator = aData.author;
  this.description = aData.description;
  this.homepageURL = aData.uri;
  this.enabled = aData.enabled;
  this.script = aData.script;
}

Script.prototype = {
  _id: null,
  version: null,
  type: "user-script",

  isCompatible: true,
  providesUpdatesSecurely: true,
  blocklistState: 0,
  appDisabled: false,
  scope: AddonManager.SCOPE_PROFILE,
  isActive: true,
  pendingOperations: 0,

  name: null,
  version: null,
  description: null,
  creator: null,
  homepageURL: null,

  script: null,

  get userDisabled() {
    return this.enabled != 1;
  },

  set userDisabled(val) {
    if (val == this.userDisabled)
      return val;

    AddonManagerPrivate.callAddonListeners(val ? "onEnabling" : "onDisabling",
                                           this, false);
    this.enabled = val ? 0 : 1;
    ScriptDatabase.updateDisabledState(this);
    AddonManagerPrivate.callAddonListeners(val ? "onEnabled" : "onDisabled",
                                           this);
  },

  get permissions() {
    var perms = AddonManager.PERM_CAN_UNINSTALL;
    perms |= this.userDisabled ? AddonManager.PERM_CAN_ENABLE : AddonManager.PERM_CAN_DISABLE;
    return perms;
  },

  isCompatibleWith: function() {
    return true;
  },

  findUpdates: function(aListener) {
    if ("onNoCompatibilityUpdateAvailable" in aListener)
      aListener.onNoCompatibilityUpdateAvailable(this);
    if ("onNoUpdateAvailable" in aListener)
      aListener.onNoUpdateAvailable(this);
    if ("onUpdateFinished" in aListener)
      aListener.onUpdateFinished(this);
  },

  uninstall: function() {
    ScriptDatabase.uninstallScript(this);
  }
};

ScriptDatabase.startup();
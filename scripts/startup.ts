import { createHash } from "crypto";
import fs from "fs";
import { DownloaderHelper } from "node-downloader-helper";
import connect, { data, plugins } from "../Modules/database";
import noAccents from "../Modules/normalize";
import { compareSemanticVersions } from "../Modules/semantic";
import store from "../types/store";
import compileAnalytics from "./compileAnalytics";
import dotenv from "dotenv";
if (process.env.APP_ENV !== "test") {
  dotenv.config({ path: ".env.local" });
} else {
  dotenv.config({ path: ".env.test.local" });
}
// Used to tell the program what version the database should get to
const currentVersion = "1.13.0";
// Creates the default config
async function createConfig() {
  const connection = await connect();
  await connection.query(
    "INSERT IGNORE INTO data (value1, value2) VALUES ('configMinTimeGame', '120'), ('configMaxTimeGame', '1200'), ('configMinTimeTransfer', '3600'), ('configMaxTimeTransfer', '86400')",
  );
}
// Downloads and generates all the plugin code
async function compilePlugins() {
  const connection = await connect();
  console.log("Compiling plugins");
  let mainFileTextStart = `// Note that this file is autogenerated by startup.ts DO NOT EDIT\nimport dataGetter from "#type/data";\n`;
  let mainFileText =
    "export const plugins: { [key: string]: dataGetter } = {\n";
  const request =
    process.env.APP_ENV !== "test"
      ? await fetch(
          "https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/default_store.json",
        ).catch(() => {
          console.error("Could not get the default store");
          return "error";
        })
      : "error";
  const defaultStore: string[] =
    request instanceof Response
      ? await request.json().catch(() => {
          console.error("Could not get the default store");
          return [];
        })
      : // Uses a fallback store if the request fails(this is also the testing store)
        [
          "https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/Bundesliga/Bundesliga.json",
        ];
  // Installs all plugins that should be installed by default
  await Promise.all(
    defaultStore.map(
      async (e) =>
        await connection.query(
          "INSERT IGNORE INTO plugins (name, settings, enabled, url) VALUES ('', '{}', 0, ?)",
          [e],
        ),
    ),
  );
  // Makes sure that bundesliga is enabled when testing
  if (process.env.APP_ENV === "test") {
    await connection.query("UPDATE plugins SET enabled=1");
  }
  const currentVersion = (await import("../package.json")).version;
  // Makes sure that the store is correct
  connection.query(
    "INSERT INTO data VALUES ('defaultStore', ?) ON DUPLICATE KEY UPDATE value2=?",
    [JSON.stringify(defaultStore), JSON.stringify(defaultStore)],
  );
  const plugins = await connection.query("SELECT * FROM plugins");
  await Promise.all(
    plugins.map(
      (e: plugins) =>
        new Promise<void>(async (res) => {
          const data = await fetch(e.url).catch(() => "error");
          if (!(data instanceof Response)) {
            res();
            console.log(`Failed to find plugin at ${e.url}`);
            return;
          }
          const json: store | "error" = await data.json().catch(() => "error");
          if (json === "error") {
            res();
            console.log(`Failed to find plugin at ${e.url}`);
            return;
          }
          connection.query("UPDATE plugins SET name=? WHERE url=?", [
            json.id,
            e.url,
          ]);
          e.name = json.id;
          // Makes sure the plugin is compatible with the current version
          if (compareSemanticVersions(json.version, currentVersion) !== 1) {
            console.error(
              `Plugin ${e.name} is not compatible with the current version of the program`,
            );
            res();
            return;
          }
          // Creates a hash of the url for storing the plugin in
          const hash = createHash("sha256").update(e.url).digest("hex");
          // Checks if the latest version for the plugin is installed
          if (
            e.version !== json.version ||
            !fs.existsSync("scripts/data/" + hash)
          ) {
            if (e.version === json.version) {
              console.log(`Updating plugin ${e.name}`);
            } else {
              console.log(`Installing plugin ${e.name}`);
            }
            // Downloads the plugin
            if (!fs.existsSync("scripts/data")) {
              fs.mkdirSync("scripts/data");
            }
            // Remove directory if it exists
            if (fs.existsSync("scripts/data/" + hash)) {
              fs.rmSync("scripts/data/" + hash, {
                recursive: true,
                force: true,
              });
            }
            fs.mkdirSync("scripts/data/" + hash);
            // Downloads all the files
            await Promise.all(
              json.files.map(
                (file) =>
                  new Promise<void>((res, rej) => {
                    const dl = new DownloaderHelper(
                      file,
                      __dirname + "/data/" + hash,
                    );
                    dl.on("end", () => res());
                    dl.on("error", (e) => rej(e));
                    dl.start().catch((e) => rej(e));
                  }),
              ),
            ).then(
              () => {
                console.log(`Finished downloading plugin ${e.name}`);
                mainFileTextStart += `import plugin${hash} from "./data/${hash}";\n`;
                mainFileText += `  "${e.url}":\n    plugin${hash},\n`;
                connection.query("UPDATE plugins SET version=? WHERE url=?", [
                  json.version,
                  e.url,
                ]);
              },
              () => {
                console.error(
                  `Failed to download plugin ${e.name}. Restart server to try again.`,
                );
                connection.query(
                  "UPDATE plugins SET version='', enabled=0  WHERE url=?",
                  [e.url],
                );
              },
            );
          } else {
            mainFileTextStart += `import plugin${hash} from "./data/${hash}";\n`;
            mainFileText += `  "${e.url}":\n    plugin${hash},\n`;
          }
          res();
        }),
    ),
  );
  mainFileText += "};\nexport default plugins;\n";
  fs.writeFileSync("scripts/data.ts", mainFileTextStart + mainFileText);
  console.log("Done compiling plugins");
}
async function startUp() {
  const connection = await connect();
  await Promise.all([
    // Used to store the users
    connection.query(
      "CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY AUTO_INCREMENT NOT NULL, username varchar(255), password varchar(60), throttle int DEFAULT 30, active bool DEFAULT 0, google varchar(255) DEFAULT '', github varchar(255) DEFAULT '', admin bool DEFAULT false, favoriteLeague int, theme varchar(10), locale varchar(5))",
    ),
    // Used to store the players data
    connection.query(
      "CREATE TABLE IF NOT EXISTS players (uid varchar(25) PRIMARY KEY, name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price int, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, locked bool, `exists` bool, league varchar(25))",
    ),
    // Creates a table that contains some key value pairs for data that is needed for some things
    connection.query(
      "CREATE TABLE IF NOT EXISTS data (value1 varchar(25) PRIMARY KEY, value2 varchar(255))",
    ),
    // Used to store the leagues settings
    connection.query(
      "CREATE TABLE IF NOT EXISTS leagueSettings (leagueName varchar(255), leagueID int PRIMARY KEY AUTO_INCREMENT NOT NULL, startMoney int DEFAULT 150000000, transfers int DEFAULT 6, duplicatePlayers int DEFAULT 1, starredPercentage int DEFAULT 150, league varchar(25), archived int DEFAULT 0, matchdayTransfers boolean)",
    ),
    // Used to store the leagues users
    connection.query(
      "CREATE TABLE IF NOT EXISTS leagueUsers (leagueID int, user int, points int, money int, formation varchar(255), admin bool DEFAULT 0, tutorial bool DEFAULT 1)",
    ),
    // Used to store the Historical Points
    connection.query(
      "CREATE TABLE IF NOT EXISTS points (leagueID int, user int, points int, matchday int, money int, time int)",
    ),
    // Used to store transfers
    connection.query(
      "CREATE TABLE IF NOT EXISTS transfers (leagueID int, seller int, buyer int, playeruid varchar(25), value int, position varchar(5) DEFAULT 'bench', starred bool DEFAULT 0, max int)",
    ),
    // Used to store invite links
    connection.query(
      "CREATE TABLE IF NOT EXISTS invite (inviteID varchar(25) PRIMARY KEY, leagueID int)",
    ),
    // Used to store player squads
    connection.query(
      "CREATE TABLE IF NOT EXISTS squad (leagueID int, user int, playeruid varchar(25), position varchar(5), starred bool DEFAULT 0)",
    ),
    // Used to store historical squads
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalSquad (matchday int, leagueID int, user int, playeruid varchar(25), position varchar(5), starred bool DEFAULT 0)",
    ),
    // Used to store historical player data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalPlayers (time int, uid varchar(25), name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price int, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, `exists` bool, league varchar(25))",
    ),
    // Used to store historical transfer data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalTransfers (matchday int, leagueID int, seller int, buyer int, playeruid varchar(25), value int)",
    ),
    // Used to store club data
    connection.query(
      "CREATE TABLE IF NOT EXISTS clubs (club varchar(3) PRIMARY KEY, gameStart int, gameEnd int, opponent varchar(3), league varchar(25))",
    ),
    // Used to store club data
    connection.query(
      "CREATE TABLE IF NOT EXISTS historicalClubs (club varchar(3), opponent varchar(3), league varchar(25), time int)",
    ),
    // Used to store analytics data
    connection.query(
      "CREATE TABLE IF NOT EXISTS analytics (day int PRIMARY KEY, versionActive varchar(255), versionTotal varchar(255), leagueActive varchar(255), leagueTotal varchar(255), themeActive varchar(255), themeTotal varchar(255), localeActive varchar(255), localeTotal varchar(255))",
    ),
    // Used to store every server's analytics data
    connection.query(
      "CREATE TABLE IF NOT EXISTS detailedAnalytics (serverID int, day int, version varchar(255), active int, total int, leagueActive varchar(255), leagueTotal varchar(255), themeActive varchar(255), themeTotal varchar(255), localeActive varchar(255), localeTotal varchar(255))",
    ),
    // Used to store league announcements
    connection.query(
      "CREATE TABLE IF NOT EXISTS announcements (leagueID int, priority varchar(10) check(priority = 'error' or priority = 'info' or priority = 'success' or priority='warning'), title varchar(255), description varchar(255))",
    ),
    // Used to store plugin settings
    connection.query(
      "CREATE TABLE IF NOT EXISTS plugins (name varchar(255), settings varchar(255), enabled boolean, url varchar(255) PRIMARY KEY, version varchar(255))",
    ),
    // Used to store picture IDs
    connection.query(
      "CREATE TABLE IF NOT EXISTS pictures (id int PRIMARY KEY AUTO_INCREMENT NOT NULL, url varchar(255), downloading boolean DEFAULT 0, downloaded boolean DEFAULT 0, height int, width int)",
    ),
  ]);
  // Checks if the server hash has been created and if not makes one
  await connection.query(
    "INSERT IGNORE INTO data (value1, value2) VALUES ('serverID', ?)",
    [String(Math.random() * 8980989890)],
  );
  // Unlocks the database
  (await connection.query("SELECT * FROM plugins")).forEach((e: plugins) => {
    connection.query("DELETE FROM data WHERE value1=?", ["locked" + e.name]);
  });
  // Checks the version of the database is out of date
  const getOldVersion: data[] = await connection.query(
    "SELECT value2 FROM data WHERE value1='version'",
  );
  let oldVersion = "";
  if (getOldVersion.length > 0) {
    oldVersion = getOldVersion[0].value2;
    if (oldVersion == "0.1.1") {
      console.log(
        "This version does not have a supported upgrade path to 1.*.*. Due to only me using this program in these versions.",
      );
    }
    if (oldVersion == "1.0.0") {
      console.log("Updating database to version 1.0.7");
      // Moves all of the old league data into the new format
      const leagues = await connection.query("SELECT * FROM leagues");
      leagues.forEach((e) => {
        connection.query(
          "INSERT IGNORE INTO leagueSettings (leagueName, leagueID) VALUES (?, ?)",
          [e.leagueName, e.leagueID],
        );
        connection.query(
          "INSERT INTO leagueUsers (leagueID, user, points, money, formation) VALUES (?, ?, ?, ?, ?)",
          [e.leagueID, e.user, e.points, e.money, e.formation],
        );
      });
      connection.query("DROP TABLE leagues");
      oldVersion = "1.0.7";
    }
    if (oldVersion == "1.0.7") {
      console.log("Updating database to version 1.1.0");
      connection.query(
        "ALTER TABLE leagueSettings ADD startMoney int DEFAULT 150000000",
      );
      connection.query(
        "ALTER TABLE leagueSettings ADD transfers int DEFAULT 6",
      );
      connection.query(
        "ALTER TABLE leagueSettings ADD duplicatePlayers int DEFAULT 1",
      );
      connection.query("ALTER TABLE leagueUsers ADD admin bool DEFAULT 0");
      connection.query("UPDATE leagueUsers SET admin=1");
      oldVersion = "1.1.0";
    }
    if (oldVersion == "1.1.0") {
      console.log("Updating database to version 1.2.0");
      await connection.query("ALTER TABLE points ADD time int");
      await connection.query("UPDATE points SET time=0");
      oldVersion = "1.2.0";
    }
    if (oldVersion == "1.2.0") {
      console.log("Updating database to version 1.3.0");
      await Promise.all([
        connection.query("ALTER TABLE squad ADD starred bool DEFAULT 0"),
        connection.query(
          "ALTER TABLE historicalSquad ADD starred bool DEFAULT 0",
        ),
        connection.query(
          "ALTER TABLE leagueSettings ADD starredPercentage int DEFAULT 150",
        ),
      ]);
      await Promise.all([
        connection.query("UPDATE squad SET starred=0"),
        connection.query("UPDATE historicalSquad SET starred=0"),
        connection.query("UPDATE leagueSettings SET starredPercentage=150"),
      ]);
      oldVersion = "1.3.0";
    }
    if (oldVersion == "1.3.0") {
      console.log("Updating database to version 1.3.1");
      await Promise.all([
        connection.query("ALTER TABLE players ADD nameAscii varchar(255)"),
        connection.query(
          "ALTER TABLE historicalPlayers ADD nameAscii varchar(255)",
        ),
      ]);
      const players = await connection.query("SELECT * FROM players");
      players.forEach((e) => {
        connection.query("UPDATE players SET nameAscii=? WHERE uid=?", [
          noAccents(e.name),
          e.uid,
        ]);
      });
      const historicalPlayers = await connection.query(
        "SELECT * FROM historicalPlayers",
      );
      historicalPlayers.forEach((e) => {
        connection.query(
          "UPDATE historicalPlayers SET nameAscii=? WHERE uid=?",
          [noAccents(e.name), e.uid],
        );
      });
      oldVersion = "1.3.1";
    }
    if (oldVersion == "1.3.1") {
      console.log("Updating database to version 1.4.3");
      await connection.query(
        "ALTER TABLE transfers ADD position varchar(5) DEFAULT 'bench'",
      );
      await connection.query(
        "ALTER TABLE transfers ADD starred bool DEFAULT 0",
      );
      await connection.query("UPDATE transfers SET position='bench'");
      await connection.query("UPDATE transfers SET starred=0");
      oldVersion = "1.4.3";
    }
    if (oldVersion == "1.4.3") {
      console.log("Updating database to version 1.5.0");
      await connection.query("ALTER TABLE transfers ADD max int");
      await connection.query("UPDATE transfers SET max=value");
      oldVersion = "1.5.0";
    }
    if (oldVersion == "1.5.0") {
      console.log("Updating database to version 1.5.1");
      await connection.query("ALTER TABLE users ADD active bool DEFAULT 0");
      await connection.query("ALTER TABLE users ADD throttle int DEFAULT 30");
      await connection.query(
        "ALTER TABLE users ADD google varchar(255) DEFAULT ''",
      );
      await connection.query(
        "ALTER TABLE users ADD github varchar(255) DEFAULT ''",
      );
      await connection.query(
        "UPDATE users SET google=users.email, github=users.email",
      );
      await connection.query("DELETE FROM data WHERE value1='updateProgram'");
      await connection.query("ALTER TABLE users DROP COLUMN email");
      oldVersion = "1.5.1";
    }
    if (oldVersion == "1.5.1") {
      console.log("Updating database to version 1.7.0");
      await connection.query("ALTER TABLE users ADD admin bool DEFAULT 0");
      await connection.query("ALTER TABLE users ADD favoriteLeague int");
      await connection.query("UPDATE users SET admin=0");
      oldVersion = "1.7.0";
    }
    if (oldVersion == "1.7.0") {
      console.log("Updating database to version 1.8.0");
      // Adds the league column to the db
      await Promise.all([
        connection.query("ALTER TABLE players ADD league varchar(25)"),
        connection.query("ALTER TABLE leagueSettings ADD league varchar(25)"),
        connection.query(
          "ALTER TABLE historicalPlayers ADD league varchar(25)",
        ),
        connection.query("ALTER TABLE clubs ADD league varchar(25)"),
      ]);
      // Sets the league column to bundesliga everywhere
      await Promise.all([
        connection.query("UPDATE players SET league='Bundesliga'"),
        connection.query("UPDATE leagueSettings SET league='Bundesliga'"),
        connection.query("UPDATE historicalPlayers SET league='Bundesliga'"),
        connection.query("UPDATE clubs SET league='Bundesliga'"),
      ]);
      // Deletes some old uneccessary data from the db and moves it to the new data
      await Promise.all([
        connection.query(
          "UPDATE data SET value1='updateBundesliga' WHERE value1='update'",
        ),
        connection.query(
          "UPDATE data SET value1='transferOpenBundesliga' WHERE value1='transferOpen'",
        ),
        connection.query(
          "UPDATE data SET value1='playerUpdateBundesliga' WHERE value1='playerUpdate'",
        ),
        connection.query(
          "UPDATE data SET value1='countdownBundesliga' WHERE value1='countdown'",
        ),
        connection.query("DELETE FROM data WHERE value1='locked'"),
      ]);
      // Adds the new columns to the analytics
      await Promise.all([
        connection.query("ALTER TABLE analytics ADD Bundesliga int"),
        connection.query("ALTER TABLE analytics ADD BundesligaActive int"),
        connection.query("ALTER TABLE analytics ADD EPL int"),
        connection.query("ALTER TABLE analytics ADD EPLActive int"),
      ]);
      await connection.query(
        "UPDATE analytics SET Bundesliga=0, BundesligaActive=0, EPL=0, EPLACTIVE=0",
      );
      oldVersion = "1.8.0";
    }
    if (oldVersion == "1.8.0") {
      console.log("Updating database to version 1.9.0");
      // Adds the new columns to the analytics and the leagueSettings table
      await Promise.all([
        connection.query("ALTER TABLE analytics ADD WorldCup2022 int"),
        connection.query("ALTER TABLE analytics ADD WorldCup2022Active int"),
        connection.query(
          "ALTER TABLE leagueSettings ADD archived int DEFAULT 0",
        ),
      ]);
      await Promise.all([
        connection.query(
          "UPDATE analytics SET WorldCup2022=0, WorldCup2022Active=0",
        ),
        connection.query("UPDATE leagueSettings SET archived=0"),
      ]);
      // Fixes all the player data to have the correct ascii name
      const players = await connection.query("SELECT * FROM players");
      await Promise.all(
        players.map((player) =>
          connection.query("UPDATE players SET nameAscii=? WHERE uid=?", [
            noAccents(player.name),
            player.uid,
          ]),
        ),
      );
      // Fixes all the player data to have the correct historical ascii name
      const historicalPlayers = await connection.query(
        "SELECT * FROM historicalPlayers",
      );
      await Promise.all(
        historicalPlayers.map((player) =>
          connection.query(
            "UPDATE historicalPlayers SET nameAscii=? WHERE uid=?",
            [noAccents(player.name), player.uid],
          ),
        ),
      );
      // Moves the leagues to a new table with the new league id style
      await connection.query(
        "CREATE TABLE IF NOT EXISTS leagueSettingsTemp (leagueName varchar(255), newLeagueID int PRIMARY KEY AUTO_INCREMENT NOT NULL, leagueID int, startMoney int DEFAULT 150000000, transfers int DEFAULT 6, duplicatePlayers int DEFAULT 1, starredPercentage int DEFAULT 150, league varchar(25), archived int DEFAULT 0)",
      );
      await connection.query(
        "INSERT INTO leagueSettingsTemp(leagueName, leagueID, startMoney, transfers, duplicatePlayers, starredPercentage, league, archived) SELECT leagueName, leagueID, startMoney, transfers, duplicatePlayers, starredPercentage, league, archived FROM leagueSettings",
      );
      // Updates the league ids in the other tables
      await Promise.all([
        connection.query(
          "UPDATE users SET favoriteLeague=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=users.favoriteLeague)",
        ),
        connection.query(
          "UPDATE leagueUsers SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=leagueUsers.leagueID)",
        ),
        connection.query(
          "UPDATE points SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=points.leagueID)",
        ),
        connection.query(
          "UPDATE transfers SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=transfers.leagueID)",
        ),
        connection.query(
          "UPDATE invite SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=invite.leagueID)",
        ),
        connection.query(
          "UPDATE squad SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=squad.leagueID)",
        ),
        connection.query(
          "UPDATE historicalSquad SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=historicalSquad.leagueID)",
        ),
        connection.query(
          "UPDATE historicalTransfers SET leagueID=(SELECT newLeagueID FROM leagueSettingsTemp WHERE leagueID=historicalTransfers.leagueID)",
        ),
      ]);
      // Moves the leagues back to the original table in the correct form
      await connection.query("DROP TABLE leagueSettings");
      await connection.query(
        "CREATE TABLE IF NOT EXISTS leagueSettings (leagueName varchar(255), leagueID int PRIMARY KEY AUTO_INCREMENT NOT NULL, startMoney int DEFAULT 150000000, transfers int DEFAULT 6, duplicatePlayers int DEFAULT 1, starredPercentage int DEFAULT 150, league varchar(25), archived int DEFAULT 0)",
      );
      await connection.query(
        "INSERT INTO leagueSettings(leagueName, leagueID, startMoney, transfers, duplicatePlayers, starredPercentage, league, archived) SELECT leagueName, newLeagueID, startMoney, transfers, duplicatePlayers, starredPercentage, league, archived FROM leagueSettingsTemp",
      );
      await connection.query("DROP TABLE leagueSettingsTemp");
      oldVersion = "1.9.0";
    }
    if (oldVersion === "1.9.0") {
      console.log("Updating database to version 1.9.1");
      // Checks if the forecast column actually exists because it was removed a long time ago but not actually dropped
      const forecastExists = await connection
        .query(
          "SELECT COUNT(*) AS CNT FROM pragma_table_info('historicalPlayers') WHERE name='forecast'",
        )
        .then((e) => e[0].CNT === 1);
      if (!forecastExists) {
        await connection.query(
          "ALTER TABLE historicalPlayers ADD forecast varchar(1)",
        );
      }
      // Sets all the forecasts for the historical players to attending because they were unknown.
      await connection.query("UPDATE historicalPlayers SET forecast='a'");
      oldVersion = "1.9.1";
    }
    if (oldVersion === "1.9.1") {
      console.log("Updating database to version 1.10.0");
      // Replaces all NA clubs names with empty showing that there is no opponent
      await Promise.all([
        connection.query("UPDATE clubs SET opponent='' WHERE opponent='NA'"),
        connection.query(
          "UPDATE historicalClubs SET opponent='' WHERE opponent='NA'",
        ),
      ]);
      oldVersion = "1.10.0";
    }
    if (oldVersion === "1.10.0") {
      console.log("Updating database to version 1.10.2");
      // Replaces all NA clubs names with empty showing that there is no opponent
      await connection.query(
        "ALTER TABLE leagueSettings ADD matchdayTransfers boolean",
      );
      await connection.query("UPDATE leagueSettings SET matchdayTransfers=0");
      await connection.query(
        "UPDATE leagueSettings SET matchdayTransfers=1 WHERE league='WorldCup2022'",
      );
      oldVersion = "1.10.2";
    }
    if (oldVersion === "1.10.2") {
      console.log("Updating database to version 1.11.0");
      // Adds User Preference saving to the database
      await connection.query("ALTER TABLE users ADD theme varchar(10)");
      await connection.query("ALTER TABLE users ADD locale varchar(5)");
      // Updates the format for the analytics
      const data = await connection.query("SELECT * FROM analytics");
      await Promise.all(
        data.map(
          (e) =>
            new Promise<void>(async (res) => {
              await connection.query(
                "INSERT INTO detailedAnalytics (serverID, day, version, active, total, leagueActive, leagueTotal, themeActive, themeTotal, localeActive, localeTotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                  e.serverID,
                  e.day,
                  e.version,
                  e.activeUsers,
                  e.users,
                  JSON.stringify({
                    Bundesliga: e.BundesligaActive,
                    EPL: e.EPLActive,
                    WorldCup2022: e.WorldCup2022Active,
                  }),
                  JSON.stringify({
                    Bundesliga: e.Bundesliga,
                    EPL: e.EPL,
                    WorldCup2022: e.WorldCup2022,
                  }),
                  "{}",
                  "{}",
                  "{}",
                  "{}",
                ],
              );
              res();
            }),
        ),
      );
      // Drops the table for the analytics and creates the correct table.
      await connection.query("DROP TABLE analytics");
      await connection.query(
        "CREATE TABLE IF NOT EXISTS analytics (day int PRIMARY KEY, versionActive varchar(255), versionTotal varchar(255), leagueActive varchar(255), leagueTotal varchar(255), themeActive varchar(255), themeTotal varchar(255), localeActive varchar(255), localeTotal varchar(255))",
      );
      // Compiles the analytics for every single day that has happened
      const minDate: number = (
        await connection.query("SELECT min(day) AS min FROM detailedAnalytics")
      )[0].min;
      const maxDate: number = (
        await connection.query("SELECT max(day) AS max FROM detailedAnalytics")
      )[0].max;
      for (let i = minDate; i <= maxDate; i++) {
        await compileAnalytics(i);
      }
      await connection.query(
        "ALTER TABLE leagueUsers ADD tutorial bool DEFAULT 1",
      );
      await connection.query("UPDATE leagueUsers SET tutorial=1");
      oldVersion = "1.11.0";
    }
    if (oldVersion === "1.11.0") {
      console.log("Updating database to version 1.12.0");
      // Adds the plugins if they were enabled with then enviromental variables in previous versions
      if (process.env.BUNDESLIGA_API) {
        await connection.query(
          "INSERT IGNORE INTO plugins (name, settings, enabled, url) VALUES ('Bundesliga', ?, 1, 'https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/Bundesliga/Bundesliga.json')",
          [JSON.stringify({ access_token: process.env.BUNDESLIGA_API })],
        );
      }
      if (process.env.ENABLE_EPL) {
        await connection.query(
          "INSERT IGNORE INTO plugins (name, settings, enabled, url) VALUES ('EPL','{}', 1, 'https://raw.githubusercontent.com/Lukasdotcom/fantasy-manager/main/store/EPL/EPL.json')",
        );
      }
      // Moves the picture urls to a new table
      await connection.query(
        "CREATE TABLE IF NOT EXISTS pictures2 (url varchar(255))",
      );
      await connection.query("ALTER TABLE players RENAME TO playersTemp");
      await connection.query(
        "CREATE TABLE IF NOT EXISTS players (uid varchar(25) PRIMARY KEY, name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, locked bool, `exists` bool, league varchar(25))",
      );
      await connection.query(
        "ALTER TABLE historicalPlayers RENAME TO historicalPlayersTemp",
      );
      connection.query(
        "CREATE TABLE IF NOT EXISTS historicalPlayers (time int, uid varchar(25), name varchar(255), nameAscii varchar(255), club varchar(3), pictureID int, value int, sale_price, position varchar(3), forecast varchar(1), total_points int, average_points int, last_match int, `exists` bool, league varchar(25))",
      );
      await connection.query(
        "INSERT INTO pictures2 (url) SELECT DISTINCT pictureUrl FROM historicalPlayersTemp",
      );
      await connection.query(
        "INSERT INTO pictures2 (url) SELECT DISTINCT pictureUrl FROM playersTemp",
      );
      await connection.query(
        "INSERT INTO pictures (url) SELECT DISTINCT url FROM pictures2",
      );
      await connection.query("DROP TABLE pictures2");
      await connection.query(
        "INSERT INTO players (uid, name, nameAscii, club, pictureID, value, sale_price, position, forecast, total_points, average_points, last_match, locked, `exists`, league) SELECT uid, name, nameAscii, club, (SELECT id FROM pictures WHERE url=playersTemp.pictureUrl), value, value, position, forecast, total_points, average_points, last_match, locked, `exists`, league FROM playersTemp",
      );
      await connection.query(
        "INSERT INTO historicalPlayers (time, uid, name, nameAscii, club, pictureID, value, sale_price, position, forecast, total_points, average_points, last_match, `exists`, league) SELECT time, uid, name, nameAscii, club, (SELECT id FROM pictures WHERE url=historicalPlayersTemp.pictureUrl), value, value, position, forecast, total_points, average_points, last_match, `exists`, league FROM historicalPlayersTemp",
      );
      await connection.query("DROP TABLE playersTemp");
      await connection.query("DROP TABLE historicalPlayersTemp");
      // Sets the height and width of each picture to what they should be
      await connection.query("UPDATE pictures SET height=200, width=200");
      await connection.query(
        "UPDATE pictures SET height=280, width=220 WHERE url LIKE 'https://resources.premierleague.com/premierleague/photos/players/%'",
      );
      await connection.query(
        "UPDATE pictures SET height=265, width=190 WHERE url LIKE 'https://play.fifa.com/media/image/headshots/%'",
      );
      // Adds the game end and sets it to 4 hours after game start.
      await connection.query("ALTER TABLE clubs ADD gameEnd int");
      await connection.query("UPDATE clubs SET gameEnd=gameStart+14400");
      // Recompiles all analytics due to a samll bug that can occur
      await connection.query("DELETE FROM analytics");
      const minDate: number = (
        await connection.query("SELECT min(day) AS min FROM detailedAnalytics")
      )[0].min;
      const maxDate: number = (
        await connection.query("SELECT max(day) AS max FROM detailedAnalytics")
      )[0].max;
      for (let i = minDate; i <= maxDate; i++) {
        await compileAnalytics(i);
      }
      oldVersion = "1.12.0";
    }
    if (oldVersion === "1.12.0") {
      console.log("Updating database to version 1.13.0");
      if (parseInt(String(process.env.MIN_UPDATE_TIME)) > 0) {
        await connection.query(
          "INSERT INTO data (value1, value2) VALUES ('configMinTimeGame', ?) ON DUPLICATE KEY UPDATE value2=?",
          [process.env.MIN_UPDATE_TIME, process.env.MIN_UPDATE_TIME],
        );
      }
      if (parseInt(String(process.env.MIN_UPDATE_TIME_TRANSFER)) > 0) {
        await connection.query(
          "INSERT INTO data (value1, value2) VALUES ('configMinTimeTransfer', ?) ON DUPLICATE KEY UPDATE value2=?",
          [
            process.env.MIN_UPDATE_TIME_TRANSFER,
            process.env.MIN_UPDATE_TIME_TRANSFER,
          ],
        );
      }
      await connection.query(
        "INSERT INTO data (value1, value2) VALUES ('configMaxTimeGame', '0'), ('configMaxTimeTransfer', '0') ON DUPLICATE KEY UPDATE value2='86400'",
      );
      // Fixes bug with previous version that had some historical sale prices at null
      await connection.query(
        "UPDATE historicalPlayers SET sale_price=value WHERE sale_price IS NULL",
      );
      await connection.query(
        "ALTER TABLE pictures ADD downloading bool DEFAULT 0",
      );
      oldVersion = "1.13.0";
    }
    // HERE IS WHERE THE CODE GOES TO UPDATE THE DATABASE FROM ONE VERSION TO THE NEXT
    // Makes sure that the database is up to date
    if (oldVersion !== currentVersion) {
      console.error("Database is corrupted or is too old");
    }
  }
  // Creates the default config if needed
  createConfig();
  // Makes sure that the admin user is the correct user
  await connection.query("UPDATE users SET admin=0");
  if (process.env.ADMIN !== undefined) {
    const adminUser = parseInt(process.env.ADMIN);
    console.log(`User ${adminUser} is the admin user`);
    connection.query("UPDATE users SET admin=1 WHERE id=?", [adminUser]);
  } else {
    console.log("Admin user is disabled");
  }
  // Updated version of database in table
  connection.query(
    "INSERT INTO data (value1, value2) VALUES('version', ?) ON DUPLICATE KEY UPDATE value2=?",
    [currentVersion, currentVersion],
  );
  connection.end();
  compilePlugins();
}
startUp();

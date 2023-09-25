import connect from "../../../../Modules/database";
import { authOptions } from "#/pages/api/auth/[...nextauth]";
import { getServerSession } from "next-auth";
import { NextApiRequest, NextApiResponse } from "next";
import { leaveLeague } from "#/Modules/delete";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (session) {
    const connection = await connect();
    const league = req.query.league;
    // Variable to check if the league is archived
    const isArchived = connection
      .query("SELECT * FROM leagueSettings WHERE leagueID=? AND archived=0", [
        league,
      ])
      .then((e) => e.length === 0);
    switch (req.method) {
      // Used to edit a league
      case "POST":
        if (await isArchived) {
          res.status(400).end("This League is archived");
          break;
        }
        // Checks if the user is qualified to do this
        if (
          (
            await connection.query(
              "SELECT * FROM leagueUsers WHERE leagueID=? AND user=? AND admin=1",
              [league, session.user.id],
            )
          ).length > 0
        ) {
          if (Array.isArray(req.body.users)) {
            // Updates all the users from admin to not admin
            req.body.users.forEach((e: { user: number; admin: boolean }) => {
              connection.query(
                "UPDATE leagueUsers SET admin=? WHERE leagueID=? and user=?",
                [e.admin, league, e.user],
              );
            });
          }
          if (req.body.settings !== undefined) {
            const settings = req.body.settings;
            if (parseInt(settings.startingMoney) > 10000)
              connection.query(
                "UPDATE leagueSettings SET startMoney=? WHERE leagueID=?",
                [parseInt(settings.startingMoney), league],
              );
            if (parseInt(settings.transfers) > 0)
              connection.query(
                "UPDATE leagueSettings SET transfers=? WHERE leagueID=?",
                [parseInt(settings.transfers), league],
              );
            if (parseInt(settings.duplicatePlayers) > 0)
              connection.query(
                "UPDATE leagueSettings SET duplicatePlayers=? WHERE leagueID=?",
                [parseInt(settings.duplicatePlayers), league],
              );
            if (parseInt(settings.starredPercentage) > 100)
              connection.query(
                "UPDATE leagueSettings SET starredPercentage=? WHERE leagueID=?",
                [parseInt(settings.starredPercentage), league],
              );
            if (settings.leagueName !== undefined) {
              connection.query(
                "UPDATE leagueSettings SET leagueName=? WHERE leagueID=?",
                [settings.leagueName, league],
              );
            }
            connection.query(
              "UPDATE leagueSettings SET matchdayTransfers=? WHERE leagueID=?",
              [Boolean(settings.matchdayTransfers), league],
            );
            connection.query(
              "UPDATE leagueSettings SET top11=? WHERE leagueID=?",
              [Boolean(settings.top11), league],
            );
            // Archives the league when told to do so
            if (settings.archive === true) {
              console.log(`League ${league} was archived`);
              connection.query(
                "UPDATE leagueSettings SET archived=? WHERE leagueID=?",
                [Math.floor(Date.now() / 1000), league],
              );
            }
          }
          res.status(200).end("Saved settings");
        } else {
          res.status(401).end("You are not admin of this league");
        }
        break;
      case "GET": // Returns the league Settings and which users are admins
        // Checks if the user is qualified to do this
        if (
          (
            await connection.query(
              "SELECT * FROM leagueUsers WHERE leagueID=? and user=?",
              [league, session.user.id],
            )
          ).length > 0
        ) {
          // Gets the settings and admin status for users
          const [settings, users] = await Promise.all([
            connection
              .query("SELECT * FROM leagueSettings WHERE leagueID=?", [league])
              .then((res) => res[0]),
            connection.query(
              "SELECT user, admin FROM leagueUsers WHERE leagueID=?",
              [league],
            ),
          ]);
          res.status(200).json({ settings, users });
        } else {
          res.status(401).end("You are not admin of this league");
        }
        break;
      case "DELETE":
        // Used to leave a league
        await leaveLeague(parseInt(String(league)), session.user.id);
        res.status(200).end("Left league");
        break;
      default:
        res.status(405).end(`Method ${req.method} Not Allowed`);
        break;
    }
    connection.end();
  } else {
    res.status(401).end("Not logged in");
  }
}
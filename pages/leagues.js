import Head from "next/head";
import { useEffect, useState } from "react";
import { getSession, SessionProvider, useSession } from "next-auth/react";
import { leagueList } from "./api/league";
import Link from "../components/Link";
import Menu from "../components/Menu";
import { push } from "@socialgouv/matomo-next";
import { TextField, Button, IconButton, Icon } from "@mui/material";
// Used to create a new League
function MakeLeague({ getLeagueData, notify }) {
  const [leagueName, setLeagueName] = useState("");
  const [startingMoney, setStartingMoney] = useState(150);
  return (
    <>
      <h2>Create League</h2>
      <TextField
        label="Starting Money"
        type="number"
        id="startingMoney"
        variant="outlined"
        size="small"
        onChange={(e) => {
          setStartingMoney(parseFloat(e.target.value));
        }}
        value={startingMoney}
      />
      <br></br>
      <TextField
        label="League Name"
        id="name"
        variant="outlined"
        size="small"
        onChange={(e) => {
          setLeagueName(e.target.value);
        }}
        value={leagueName}
      />
      <br></br>
      <Button
        variant="contained"
        onClick={async () => {
          push(["trackEvent", "League", "Create", leagueName]);
          notify("Saving");
          // Used to create a league
          const response = await fetch("/api/league", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: leagueName,
              "Starting Money": startingMoney * 1000000,
            }),
          });
          notify(await response.text(), response.ok ? "success" : "error");
          getLeagueData();
        }}
      >
        Create League
      </Button>
    </>
  );
}
// Used to leave a league
function LeaveLeague({ leagueID, getLeagueData, notify }) {
  return (
    <Button
      style={{ margin: "5px" }}
      variant="outlined"
      color="error"
      id={leagueID}
      onClick={async (e) => {
        notify("Leaving");
        push(["trackEvent", "League", "Leave", leagueID]);
        const response = await fetch(`/api/league/${leagueID}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
        });
        notify(await response.text(), response.ok ? "success" : "error");
        getLeagueData();
      }}
      className="red-button"
    >
      Leave League
    </Button>
  );
}
// Used to list all the leagues you are part of and to add a league
function Leagues({ leagueData, notify }) {
  const { data: session } = useSession();
  const [leagueList, setLeagueList] = useState(leagueData);
  const [favoriteLeague, setFavoriteLeague] = useState(undefined);
  // Gets the favorite league
  useEffect(() => {
    // Only updates this when favorite league is undefined
    if (favoriteLeague || !session) {
      return;
    }
    const favoriteLeague = leagueList.filter(
      (e) => e.leagueID === session.user.favoriteLeague
    );
    setFavoriteLeague(
      favoriteLeague.length > 0 ? favoriteLeague[0] : undefined
    );
  }, [session, leagueList]);
  // Used to update the favorite
  async function updateFavorite(val) {
    let leagueID = "none";
    if (val) {
      leagueID = val.leagueID;
    }
    notify("Updaing Favorite");
    const response = await fetch("/api/user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        favorite: leagueID,
      }),
    });
    notify(await response.text(), response.ok ? "success" : "error");
    setFavoriteLeague(val);
  }
  if (session) {
    // Used to get a list of all the leagues
    const getLeagueData = async () => {
      let data = await fetch("/api/league");
      setLeagueList(await data.json());
    };
    return (
      <>
        <h1>Leagues</h1>
        <p>
          Your favorited league will be available in the menu when you are not
          in a league. Note that the menu only updates on a page navigation or
          reload.
        </p>
        {favoriteLeague && (
          <p>Your favorite league is: {favoriteLeague.leagueName}.</p>
        )}
        {!favoriteLeague && <p>You have no favorite league.</p>}
        {leagueList.map((val) => (
          // Makes a link for every league
          <div key={val.leagueID}>
            <strong>{val.leagueName}</strong>
            <Link href={`/${val.leagueID}`}>
              <Button style={{ margin: "5px" }} variant="outlined">
                Open League
              </Button>
            </Link>
            <LeaveLeague
              leagueID={val.leagueID}
              getLeagueData={getLeagueData}
              notify={notify}
            />
            <IconButton
              style={{ margin: "5px" }}
              color="secondary"
              onClick={() => updateFavorite(val)}
            >
              <Icon>
                {favoriteLeague && favoriteLeague.leagueID === val.leagueID
                  ? "star"
                  : "star_outline"}
              </Icon>
            </IconButton>
          </div>
        ))}
        <Button
          color="error"
          variant="outlined"
          onClick={() => updateFavorite(undefined)}
        >
          Clear Favorite League<Icon>delete</Icon>
        </Button>
        <MakeLeague getLeagueData={getLeagueData} notify={notify} />
      </>
    );
  } else {
    return <p>You shouldn&apos;t be here. Log in please.</p>;
  }
}
export default function Home({ leagueData, notify }) {
  return (
    <>
      <Head>
        <title>Leagues</title>
      </Head>
      <Menu />
      <h1>Bundesliga Fantasy Manager</h1>
      <SessionProvider>
        <Leagues leagueData={leagueData} notify={notify} />
      </SessionProvider>
    </>
  );
}

export async function getServerSideProps(ctx) {
  const session = getSession(ctx);
  if (await session) {
    return {
      props: {
        leagueData: JSON.parse(
          JSON.stringify(await leagueList((await session).user.id))
        ),
      },
    };
  } else {
    return {
      redirect: {
        destination: `/api/auth/signin?callbackUrl=${encodeURIComponent(
          ctx.resolvedUrl
        )}`,
        permanent: false,
      },
    };
  }
}

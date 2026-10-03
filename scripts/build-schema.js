// Generates schemas/trainer_talk.schema.json: the slot list the packager
// uses when a mod zip ships no schema.json of its own. The same file is
// meant to be copied into the Trainer Talk repo as its own schema.json.
const fs = require("fs");
const path = require("path");

// direction: by_you = caused by the player's side, to_you = happens to the
//   player's side, none = no side involved.
// tone: positive | negative | neutral.
// intensity: the escalation ladder, 1 (small) to 5 (biggest).
const slots = [];
const add = (ids, group, moment, direction, tone, intensity) =>
  ids.forEach((id) => slots.push({ id, group, moment, direction, tone, intensity }));

add(["new_game"], "Game start", "A brand-new save begins: an introduction", "none", "neutral", 2);
add(["continue1", "continue2", "continue3", "continue4", "continue5"], "Game start",
  "Picking up an existing save: a short greeting", "none", "neutral", 1);
add(["hit1", "hit2", "hit3"], "Battle", "Your Pokémon attacks: a command or battle cry", "by_you", "positive", 1);
add(["status_enemy", "status_enemy2"], "Battle", "Your side inflicts a status condition on the opponent", "by_you", "positive", 2);
add(["status_player", "status_player2"], "Battle", "Your Pokémon is hit by a status condition", "to_you", "negative", 2);
add(["hit_crit", "hit_crit2"], "Reactions", "Your Pokémon lands a critical hit", "by_you", "positive", 3);
add(["move_miss", "move_miss2"], "Reactions", "Your Pokémon's move misses", "by_you", "negative", 2);
add(["catch_fail", "catch_fail2"], "Reactions", "A Poké Ball fails to catch", "by_you", "negative", 2);
add(["run_success", "run_success2"], "Reactions", "You escape a wild battle", "by_you", "positive", 1);
add(["run_fail", "run_fail2"], "Reactions", "You fail to escape a wild battle", "to_you", "negative", 2);
add(["faint_enemy", "faint_enemy2"], "Faints", "The opponent's Pokémon faints", "by_you", "positive", 3);
add(["faint_player", "faint_player2"], "Faints", "Your Pokémon faints", "to_you", "negative", 4);
add(["evolved"], "Moments", "One of your Pokémon evolves", "to_you", "positive", 3);
add(["new_catch", "new_catch2"], "Moments", "You catch a species you didn't have", "by_you", "positive", 3);
add(["blackout", "blackout2"], "Moments", "You black out and wake at a Pokémon Center", "to_you", "negative", 5);
add(["battle_win", "battle_win2"], "Moments", "You win an ordinary trainer battle", "by_you", "positive", 3);
add(["battle_loss", "battle_loss2"], "Moments", "You lose a battle", "to_you", "negative", 4);
add(["gym_enter", "gym_enter2", "gym_enter3"], "Gyms and Elite Four", "Walking into a Gym", "none", "neutral", 2);
add(["e4_enter", "e4_enter2"], "Gyms and Elite Four", "Walking into an Elite Four room", "none", "neutral", 3);
add(["champion_enter", "champion_enter2"], "Gyms and Elite Four", "Walking into the Champion's room", "none", "neutral", 4);
add(["night1", "night2", "night3"], "Day and night", "Night falls", "none", "neutral", 1);
add(["morning1", "morning2"], "Day and night", "Morning arrives", "none", "neutral", 1);

const schema = {
  schema_version: 1,
  mod_id: "trainer_talk",
  pack_types: {
    trainer: { root: "assets/characters", slots },
    milestone: {
      root: "assets/milestones",
      speakers: [
        "brock", "misty", "surge", "erika", "koga", "sabrina", "blaine", "giovanni",
        "lorelei", "bruno", "agatha", "lance", "champion",
        "falkner", "bugsy", "whitney", "morty", "chuck", "jasmine", "pryce", "clair",
        "will", "karen", "janine", "blue",
      ],
      parts: [
        { id: "intro", moment: "The leader's challenge line as the battle starts", direction: "none", tone: "neutral", intensity: 3 },
        { id: "outro", moment: "The leader congratulates the player after losing", direction: "to_you", tone: "positive", intensity: 3 },
      ],
    },
  },
};

if (slots.length !== 48) throw new Error("expected 48 trainer slots, got " + slots.length);
fs.writeFileSync(path.join(__dirname, "..", "schemas", "trainer_talk.schema.json"),
  JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${slots.length} trainer slots and ${schema.pack_types.milestone.speakers.length} milestone speakers`);

# Contributing a recipe

1. Build the pack in the app and review every slot.
2. Give each audio zip a clear name in setup (it's what people see in the list of needed zips, for example "Blue, Sevii outfit"). On the Export screen, enter your name and choose **Save recipe…**, keeping "Also save the list of zips it needs" ticked. Include transcripts only if you want them public.
3. Put the file at `recipes/<pack_type>/<folder>/<your-name>.json`, for example `recipes/trainer/blue/elvieblooms.json`.
4. Open a pull request saying which zips the recipe was built from (by name, not by link).

Recipes contain no audio and no links to audio. Pull requests that add either will be closed.

Include the `.needed-zips.md` file in the pull request description. Before opening the pull request, run `npm test`. It checks every recipe in `recipes/` against the slot list.

/** Startup wording for the opt-in --goal conversation. */
export function goalStartupPrompt(directory: string, name: string): string {
  return [
    `Your startup identity name is ${JSON.stringify(name)}.`,
    `The startup directory is ${JSON.stringify(directory)}.`,
    "Begin by telling the user your name and where you are, and asking: \"Is there a Goal you'd like me to orient to?\"",
    "The user maintains Goals in JEPM, the work-management component of Scryer. The JEPM API is located at http://smux-linode:43210.",
    "Retrieve Goals using HTTP GET requests:\n" +
      "- /api/goals: list Goals.\n" +
      "- /api/goals/search?q=<URL-encoded query>: find Goals by text.\n" +
      "- /api/goals/<goal_uuid>: fetch a specific Goal, including its description and checklist items.\n" +
      "- /api/goals/<goal_uuid>/relationships: retrieve its relationships to other Goals.\n" +
      "- /api/goals/<goal_uuid>/activity: retrieve its recorded activity and actor attribution.",
    "Ask the user which goal they would like to work on, and provide a numbered list of open goals, if asked. Do not render the uuids. The user may respond with words or numbers, and may select multiple goals for you to work on in this session.",
    "Once the user selects a goal, send an update to the interaction service with your name and both the title and the uuid of the goal you have been selected to work on",
    "You may not execute any work until explicitly authorized by the user",
  ].join("\n\n");
}

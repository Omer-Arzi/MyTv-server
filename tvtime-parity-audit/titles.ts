// The 21 titles visible in the user's TV Time screenshots, audited for
// parity against MyTv's current Watch Next / Haven't Watched For A While.
// Aliases are additional known name variants worth searching for alongside
// the primary title (case/punctuation handled by match-titles.ts, not here).

export interface TvTimeTitleEntry {
  tvTimeTitle: string;
  aliases: string[];
}

export const TVTIME_VISIBLE_TITLES: TvTimeTitleEntry[] = [
  { tvTimeTitle: 'Mushoku Tensei: Jobless Reincarnation', aliases: ['Mushoku Tensei'] },
  { tvTimeTitle: 'Daemons of the Shadow Realm', aliases: [] },
  { tvTimeTitle: 'Black Torch', aliases: [] },
  { tvTimeTitle: "X-Men '97", aliases: ['X-Men 97'] },
  { tvTimeTitle: 'Mom', aliases: [] },
  { tvTimeTitle: 'Digimon Beatbreak', aliases: [] },
  { tvTimeTitle: 'Star Wars: Maul – Shadow Lord', aliases: ['Star Wars: Maul', 'Star Wars: Maul - Shadow Lord'] },
  { tvTimeTitle: 'Murder Drones', aliases: [] },
  { tvTimeTitle: 'Rick and Morty', aliases: [] },
  { tvTimeTitle: 'The Bear', aliases: [] },
  { tvTimeTitle: 'Devil May Cry (2025)', aliases: ['Devil May Cry'] },
  { tvTimeTitle: 'The Legend of Vox Machina', aliases: [] },
  { tvTimeTitle: 'House of the Dragon', aliases: [] },
  { tvTimeTitle: 'My Adventures with Superman', aliases: [] },
  { tvTimeTitle: 'One Piece', aliases: ['ONE PIECE (2023)'] },
  { tvTimeTitle: 'Ascendance of a Bookworm', aliases: [] },
  { tvTimeTitle: 'Jujutsu Kaisen', aliases: [] },
  { tvTimeTitle: 'Solar Opposites', aliases: [] },
  { tvTimeTitle: 'InuYasha', aliases: ['Inuyasha', 'InuYasha: The Final Act'] },
  { tvTimeTitle: 'That Time I Got Reincarnated as a Slime', aliases: [] },
  { tvTimeTitle: "Hell's Paradise", aliases: [] },
];

export const ABI = [
  "function createPoll(string title, string[] options) returns (uint256)",
  "function vote(uint256 pollId, uint256 optionIndex)",
  "function getPoll(uint256 pollId) view returns (address creator, string title, string[] options, uint256[] votes)",
  "function pollCount() view returns (uint256)",
  "function hasVoted(uint256, address) view returns (bool)",
];
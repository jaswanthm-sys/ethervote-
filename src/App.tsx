import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatEther } from "ethers";
import type { Eip1193Provider } from "ethers";
import * as abiModule from "./abi";
import * as configModule from "./config";
import "./App.css";

/* ==========================================================================
   Config & ABI Resolution (Preserves ./abi and ./config imports untouched)
   ========================================================================== */

const rawConfig = configModule as Record<string, unknown>;

function pickString(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = rawConfig[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

function pickNumber(keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = rawConfig[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = value.startsWith("0x")
        ? parseInt(value, 16)
        : parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

const CONTRACT_ADDRESS: string = pickString(
  ["CONTRACT_ADDRESS", "VOTING_CONTRACT_ADDRESS", "ADDRESS", "contractAddress", "default"],
  "0x000000000000000000000000000000000000dEaD"
);

const SEPOLIA_CHAIN_ID: number = pickNumber(
  ["SEPOLIA_CHAIN_ID", "CHAIN_ID", "TARGET_CHAIN_ID", "chainId"],
  11155111
);

const SEPOLIA_CHAIN_HEX: string = pickString(
  ["SEPOLIA_CHAIN_HEX", "SEPOLIA_CHAIN_ID_HEX", "CHAIN_ID_HEX", "chainIdHex"],
  "0x" + SEPOLIA_CHAIN_ID.toString(16)
);

const SEPOLIA_RPC_URL: string = pickString(
  ["SEPOLIA_RPC_URL", "RPC_URL", "READ_RPC_URL", "PUBLIC_RPC_URL", "rpcUrl"],
  "https://ethereum-sepolia-rpc.publicnode.com"
);

const ETHERSCAN_BASE_URL: string = pickString(
  ["ETHERSCAN_BASE_URL", "ETHERSCAN_URL", "EXPLORER_URL", "etherscanUrl"],
  "https://sepolia.etherscan.io"
);

const SEPOLIA_FAUCET_URL: string = pickString(
  ["SEPOLIA_FAUCET_URL", "FAUCET_URL"],
  "https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
);

function resolveContractAbi(): ReadonlyArray<Record<string, unknown> | string> {
  const mod = abiModule as Record<string, unknown>;
  for (const key of ["CONTRACT_ABI", "ABI", "VOTING_ABI", "POLL_ABI", "abi", "default"]) {
    if (Array.isArray(mod[key])) {
      return mod[key] as ReadonlyArray<Record<string, unknown> | string>;
    }
  }
  const firstArray = Object.values(mod).find(Array.isArray);
  if (Array.isArray(firstArray)) {
    return firstArray as ReadonlyArray<Record<string, unknown> | string>;
  }
  return [
    "function pollCount() view returns (uint256)",
    "function getPoll(uint256 pollId) view returns (string question, string[] options, uint256[] votes, address creator)",
    "function hasVoted(uint256 pollId, address voter) view returns (bool)",
    "function createPoll(string question, string[] options) returns (uint256)",
    "function vote(uint256 pollId, uint256 optionIndex)"
  ];
}

const CONTRACT_ABI = resolveContractAbi();

/* ==========================================================================
   Types & Interfaces
   ========================================================================== */

interface EthereumProvider extends Eip1193Provider {
  isMetaMask?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type ScreenName = "home" | "connect" | "create" | "explore" | "results";

interface RouteState {
  screen: ScreenName;
  pollId: number | null;
}

export interface PollData {
  id: number;
  question: string;
  options: string[];
  votes: number[];
  totalVotes: number;
  creator: string;
  hasVoted: boolean;
}

type FilterMode = "all" | "open" | "voted" | "mine";
type SortMode = "newest" | "most_votes";
type TxStage = "idle" | "confirm" | "mining" | "done";

interface ToastItem {
  id: number;
  type: "success" | "error" | "info";
  title: string;
  message: string;
  txHash?: string;
}

/* ==========================================================================
   Contract Limits & Utilities
   ========================================================================== */

const QUESTION_MAX_LENGTH = 50;
const QUESTION_MIN_LENGTH = 5;
const OPTION_MAX_LENGTH = 32;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

const HERO_DEMO_OPTIONS: ReadonlyArray<{ label: string; pct: number; votes: number }> = [
  { label: "Zero-knowledge rollup bridge", pct: 58, votes: 142 },
  { label: "Optimistic dispute verifier", pct: 29, votes: 71 },
  { label: "Keep existing L1 timelock", pct: 13, votes: 32 }
];

function parseHashRoute(hash: string): RouteState {
  const cleaned = hash.replace(/^#\/?/, "").trim();
  if (!cleaned || cleaned === "home") {
    return { screen: "home", pollId: null };
  }
  if (cleaned === "connect") {
    return { screen: "connect", pollId: null };
  }
  if (cleaned === "create") {
    return { screen: "create", pollId: null };
  }
  if (cleaned === "explore") {
    return { screen: "explore", pollId: null };
  }
  if (cleaned.startsWith("results/")) {
    const rawId = cleaned.slice("results/".length);
    const parsedId = Number.parseInt(rawId, 10);
    if (Number.isFinite(parsedId) && parsedId >= 0) {
      return { screen: "results", pollId: parsedId };
    }
  }
  return { screen: "home", pollId: null };
}

function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address || "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function extractErrorMessage(err: unknown): string {
  if (!err) return "Transaction failed.";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.shortMessage === "string" && obj.shortMessage.length > 0) {
      return obj.shortMessage;
    }
    if (typeof obj.reason === "string" && obj.reason.length > 0) {
      return obj.reason;
    }
    if (typeof obj.message === "string" && obj.message.length > 0) {
      if (obj.message.includes("user rejected") || obj.message.includes("ACTION_REJECTED")) {
        return "Transaction rejected in wallet.";
      }
      return obj.message.length > 110 ? `${obj.message.slice(0, 110)}...` : obj.message;
    }
  }
  return "An unexpected blockchain error occurred.";
}

function getPollStatusLeader(poll: PollData): {
  status: "none" | "tie" | "leading";
  leaderText: string;
  maxVotes: number;
  leadingIndices: number[];
} {
  if (poll.totalVotes === 0 || poll.votes.length === 0) {
    return {
      status: "none",
      leaderText: "No votes yet",
      maxVotes: 0,
      leadingIndices: []
    };
  }
  const maxVotes = Math.max(...poll.votes);
  const leadingIndices: number[] = [];
  poll.votes.forEach((count, idx) => {
    if (count === maxVotes && maxVotes > 0) {
      leadingIndices.push(idx);
    }
  });

  if (leadingIndices.length > 1) {
    return {
      status: "tie",
      leaderText: "Tie",
      maxVotes,
      leadingIndices
    };
  }

  const winnerIndex = leadingIndices[0] ?? 0;
  const winnerLabel = poll.options[winnerIndex] ?? `Option ${winnerIndex + 1}`;
  return {
    status: "leading",
    leaderText: winnerLabel,
    maxVotes,
    leadingIndices
  };
}

function normalizePollResult(
  id: number,
  raw: unknown,
  voterHasVoted: boolean
): PollData {
  const record = raw as Record<string, unknown> & ArrayLike<unknown>;

  let question = "";
  let options: string[] = [];
  let votes: number[] = [];
  let creator = "0x0000000000000000000000000000000000000000";

  if (typeof record?.question === "string") {
    question = record.question;
  } else if (typeof record?.title === "string") {
    question = record.title;
  } else if (typeof record?.[0] === "string") {
    question = record[0];
  } else if (typeof record?.[1] === "string") {
    question = record[1];
  }

  const rawOptions =
    record?.options ??
    record?.choices ??
    (Array.isArray(record?.[1]) ? record[1] : undefined) ??
    (Array.isArray(record?.[2]) ? record[2] : []);

  if (Array.isArray(rawOptions)) {
    options = rawOptions.map((item) => String(item));
  }

  const rawVotes =
    record?.votes ??
    record?.voteCounts ??
    (Array.isArray(record?.[2]) ? record[2] : undefined) ??
    (Array.isArray(record?.[3]) ? record[3] : []);

  if (Array.isArray(rawVotes)) {
    votes = rawVotes.map((v) => {
      if (typeof v === "bigint") return Number(v);
      if (typeof v === "number") return v;
      const parsed = Number(v);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  }

  if (votes.length < options.length) {
    votes = [...votes, ...new Array(options.length - votes.length).fill(0)];
  }

  const rawCreator =
    record?.creator ??
    record?.owner ??
    record?.author ??
    (typeof record?.[3] === "string" ? record[3] : undefined) ??
    (typeof record?.[4] === "string" ? record[4] : undefined);

  if (typeof rawCreator === "string" && rawCreator.startsWith("0x")) {
    creator = rawCreator;
  }

  const totalVotes = votes.reduce((acc, n) => acc + n, 0);

  return {
    id,
    question: question || `Poll #${id}`,
    options,
    votes,
    totalVotes,
    creator,
    hasVoted: voterHasVoted
  };
}

/* ==========================================================================
   Hooks & Helper Components
   ========================================================================== */

function useCountUp(target: number, durationMs = 650): number {
  const [displayValue, setDisplayValue] = useState<number>(target);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      setDisplayValue(target);
      return;
    }

    let animationFrameId = 0;
    const startTime = performance.now();
    const startValue = 0;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startValue + (target - startValue) * eased);
      setDisplayValue(current);
      if (progress < 1) {
        animationFrameId = requestAnimationFrame(step);
      }
    };

    animationFrameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationFrameId);
  }, [target, durationMs]);

  return displayValue;
}

interface RevealSectionProps {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}

function RevealSection({ children, className = "", ariaLabel }: RevealSectionProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -30px 0px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      aria-label={ariaLabel}
      className={`reveal-section ${isVisible ? "is-visible" : ""} ${className}`.trim()}
    >
      {children}
    </section>
  );
}

/* ==========================================================================
   Main Application Component
   ========================================================================== */

export default function App() {
  /* --- Background Cursor Spotlight Ref (Throttled via rAF, Touch & Reduced Motion Safe) --- */
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const shellEl = shellRef.current;
    if (!shellEl || typeof window === "undefined") return;

    const isTouchDevice =
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches) ||
      "ontouchstart" in window;

    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (isTouchDevice || prefersReducedMotion) {
      shellEl.style.setProperty("--cursor-x", "-999px");
      shellEl.style.setProperty("--cursor-y", "-999px");
      return;
    }

    let rafId: number | null = null;
    let latestX = -999;
    let latestY = -999;
    let lastFlush = 0;

    const flushPosition = (now: number) => {
      rafId = null;
      lastFlush = now;
      shellEl.style.setProperty("--cursor-x", `${Math.round(latestX)}px`);
      shellEl.style.setProperty("--cursor-y", `${Math.round(latestY)}px`);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      latestX = event.clientX;
      latestY = event.clientY;
      const now = performance.now();
      if (rafId === null) {
        const delay = Math.max(0, 32 - (now - lastFlush));
        rafId = window.setTimeout(() => {
          rafId = window.requestAnimationFrame(flushPosition);
        }, delay);
      }
    };

    const handlePointerLeave = () => {
      latestX = -999;
      latestY = -999;
      shellEl.style.setProperty("--cursor-x", "-999px");
      shellEl.style.setProperty("--cursor-y", "-999px");
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerleave", handlePointerLeave);
      if (rafId !== null) {
        window.clearTimeout(rafId);
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  /* --- Routing --- */
  const [route, setRoute] = useState<RouteState>(() =>
    parseHashRoute(typeof window !== "undefined" ? window.location.hash : "#home")
  );

  /* --- Wallet State --- */
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balanceEth, setBalanceEth] = useState<string>("0");
  const [isZeroBalance, setIsZeroBalance] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [copiedAddress, setCopiedAddress] = useState<boolean>(false);

  /* --- Contract & Polls State --- */
  const [polls, setPolls] = useState<PollData[]>([]);
  const [isLoadingPolls, setIsLoadingPolls] = useState<boolean>(true);
  const [votingPollKey, setVotingPollKey] = useState<string | null>(null);
  const [lastUpdatedTimestamp, setLastUpdatedTimestamp] = useState<number>(() => Date.now());
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0);

  /* --- Create Poll Form State --- */
  const [questionInput, setQuestionInput] = useState<string>("");
  const [optionInputs, setOptionInputs] = useState<string[]>(["", ""]);
  const [createTxStage, setCreateTxStage] = useState<TxStage>("idle");

  /* --- Explore Filters & Sort --- */
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  /* --- Results Share Copy State --- */
  const [sharedCopied, setSharedCopied] = useState<boolean>(false);

  /* --- Global Toasts --- */
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdCounter = useRef<number>(1);

  const hasMetaMask =
    typeof window !== "undefined" && Boolean(window.ethereum);
  const isOnSepolia = chainId === SEPOLIA_CHAIN_ID;
  const isWrongNetwork = Boolean(account) && chainId !== null && !isOnSepolia;

  /* --- Read Provider (Preserved) --- */
  const readProvider = useMemo(
    () => new JsonRpcProvider(SEPOLIA_RPC_URL),
    []
  );

  const readContract = useMemo(
    () => new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider),
    [readProvider]
  );

  /* --- Toast Helpers --- */
  const addToast = useCallback(
    (
      type: ToastItem["type"],
      title: string,
      message: string,
      txHash?: string
    ) => {
      const id = toastIdCounter.current++;
      setToasts((prev) => [...prev, { id, type, title, message, txHash }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 5200);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /* --- Navigation Helper --- */
  const navigate = useCallback((targetHash: string) => {
    if (window.location.hash === targetHash) {
      setRoute(parseHashRoute(targetHash));
    } else {
      window.location.hash = targetHash;
    }
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHashRoute(window.location.hash));
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("hashchange", handleHashChange);
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#home");
    }
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  /* --- Balance Sync --- */
  const refreshWalletBalance = useCallback(
    async (walletAddr: string | null) => {
      if (!walletAddr) {
        setBalanceEth("0");
        setIsZeroBalance(false);
        return;
      }
      try {
        let balanceWei = 0n;
        if (window.ethereum && chainId === SEPOLIA_CHAIN_ID) {
          const browserProvider = new BrowserProvider(window.ethereum);
          balanceWei = await browserProvider.getBalance(walletAddr);
        } else {
          balanceWei = await readProvider.getBalance(walletAddr);
        }
        setIsZeroBalance(balanceWei === 0n);
        const formatted = Number.parseFloat(formatEther(balanceWei));
        setBalanceEth(
          formatted === 0
            ? "0.0000"
            : formatted < 0.0001
            ? "< 0.0001"
            : formatted.toFixed(4)
        );
      } catch {
        setBalanceEth("0.0000");
        setIsZeroBalance(true);
      }
    },
    [chainId, readProvider]
  );

  /* --- Load All Polls (Preserves pollCount, getPoll, hasVoted) --- */
  const fetchAllPolls = useCallback(
    async (silent = false) => {
      if (!silent) {
        setIsLoadingPolls(true);
      }
      try {
        const rawCount: bigint = await readContract.pollCount();
        const totalCount = Number(rawCount);

        if (totalCount <= 0) {
          setPolls([]);
          setLastUpdatedTimestamp(Date.now());
          setSecondsSinceUpdate(0);
          return;
        }

        const ids = Array.from({ length: totalCount }, (_, idx) => idx);
        const fetchedPolls = await Promise.all(
          ids.map(async (pollId) => {
            try {
              const rawPoll = await readContract.getPoll(pollId);
              let voted = false;
              if (account) {
                try {
                  voted = Boolean(await readContract.hasVoted(pollId, account));
                } catch {
                  voted = false;
                }
              }
              return normalizePollResult(pollId, rawPoll, voted);
            } catch {
              return null;
            }
          })
        );

        const validPolls = fetchedPolls.filter(
          (item): item is PollData => item !== null && item.options.length > 0
        );

        setPolls(validPolls);
        setLastUpdatedTimestamp(Date.now());
        setSecondsSinceUpdate(0);
      } catch (err) {
        if (!silent) {
          addToast(
            "error",
            "Failed to sync polls",
            extractErrorMessage(err)
          );
        }
      } finally {
        if (!silent) {
          setIsLoadingPolls(false);
        }
      }
    },
    [account, addToast, readContract]
  );

  useEffect(() => {
    void fetchAllPolls(false);
  }, [fetchAllPolls]);

  /* --- Live "Last updated Xs ago" Counter --- */
  useEffect(() => {
    const interval = window.setInterval(() => {
      const diffSec = Math.max(
        0,
        Math.floor((Date.now() - lastUpdatedTimestamp) / 1000)
      );
      setSecondsSinceUpdate(diffSec);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [lastUpdatedTimestamp]);

  /* --- Wallet Logic (Connect, Disconnect, Switch to Sepolia, Listeners, Reconnect) --- */
  const syncChainId = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      const hexChainId = (await window.ethereum.request({
        method: "eth_chainId"
      })) as string;
      const numericChain = Number.parseInt(hexChainId, 16);
      setChainId(Number.isFinite(numericChain) ? numericChain : null);
    } catch {
      setChainId(null);
    }
  }, []);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      addToast(
        "error",
        "MetaMask not detected",
        "Install the MetaMask browser extension to connect your wallet."
      );
      return;
    }
    setIsConnecting(true);
    try {
      const browserProvider = new BrowserProvider(window.ethereum);
      const accounts = (await browserProvider.send(
        "eth_requestAccounts",
        []
      )) as string[];
      const network = await browserProvider.getNetwork();
      const connectedAccount = accounts[0] ?? null;

      setAccount(connectedAccount);
      setChainId(Number(network.chainId));
      await refreshWalletBalance(connectedAccount);

      if (connectedAccount) {
        addToast(
          "success",
          "Wallet connected",
          `Connected as ${shortenAddress(connectedAccount)}`
        );
      }
    } catch (err) {
      addToast("error", "Connection failed", extractErrorMessage(err));
    } finally {
      setIsConnecting(false);
    }
  }, [addToast, refreshWalletBalance]);

  const disconnectWallet = useCallback(() => {
    setAccount(null);
    setBalanceEth("0");
    setIsZeroBalance(false);
    addToast("info", "Wallet disconnected", "Your local session was cleared.");
  }, [addToast]);

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) {
      addToast("error", "MetaMask required", "Please install MetaMask first.");
      return;
    }
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_HEX }]
      });
      await syncChainId();
      addToast("success", "Network switched", "You are now on Sepolia.");
    } catch (switchErr) {
      const errObj = switchErr as { code?: number };
      if (errObj?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: SEPOLIA_CHAIN_HEX,
                chainName: "Sepolia Test Network",
                nativeCurrency: {
                  name: "Sepolia Ether",
                  symbol: "ETH",
                  decimals: 18
                },
                rpcUrls: [SEPOLIA_RPC_URL],
                blockExplorerUrls: [ETHERSCAN_BASE_URL]
              }
            ]
          });
          await syncChainId();
          addToast("success", "Sepolia added", "Switched to Sepolia network.");
        } catch (addErr) {
          addToast(
            "error",
            "Could not add Sepolia",
            extractErrorMessage(addErr)
          );
        }
      } else {
        addToast(
          "error",
          "Network switch failed",
          extractErrorMessage(switchErr)
        );
      }
    }
  }, [addToast, syncChainId]);

  /* --- Reconnect on reload & accountsChanged / chainChanged listeners --- */
  useEffect(() => {
    if (!window.ethereum) return;

    const initWallet = async () => {
      try {
        await syncChainId();
        const accounts = (await window.ethereum?.request({
          method: "eth_accounts"
        })) as string[];
        if (Array.isArray(accounts) && accounts.length > 0) {
          setAccount(accounts[0]);
          await refreshWalletBalance(accounts[0]);
        }
      } catch {
        // Silent initial check
      }
    };

    void initWallet();

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const nextAccount = accounts[0] ?? null;
      setAccount(nextAccount);
      void refreshWalletBalance(nextAccount);
    };

    const handleChainChanged = (...args: unknown[]) => {
      const rawHex = typeof args[0] === "string" ? args[0] : "";
      const parsed = Number.parseInt(rawHex, 16);
      setChainId(Number.isFinite(parsed) ? parsed : null);
      if (account) {
        void refreshWalletBalance(account);
      }
    };

    window.ethereum.on?.("accountsChanged", handleAccountsChanged);
    window.ethereum.on?.("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [account, refreshWalletBalance, syncChainId]);

  /* --- Contract Write: Create Poll (Preserves BrowserProvider signer flow + createPoll) --- */
  const formValidationReason = useMemo((): string | null => {
    if (!account) return "Connect your wallet to create a poll.";
    if (!isOnSepolia) return "Switch your wallet network to Sepolia.";
    const trimmedQ = questionInput.trim();
    if (trimmedQ.length < QUESTION_MIN_LENGTH) {
      return `Enter a question (${QUESTION_MIN_LENGTH}–${QUESTION_MAX_LENGTH} characters).`;
    }
    if (trimmedQ.length > QUESTION_MAX_LENGTH) {
      return `Question exceeds ${QUESTION_MAX_LENGTH} characters.`;
    }
    const trimmedOptions = optionInputs.map((o) => o.trim());
    if (trimmedOptions.some((o) => o.length === 0)) {
      return "Fill in every option field before submitting.";
    }
    if (trimmedOptions.some((o) => o.length > OPTION_MAX_LENGTH)) {
      return `Each option must be ${OPTION_MAX_LENGTH} characters or fewer.`;
    }
    if (trimmedOptions.length < MIN_OPTIONS || trimmedOptions.length > MAX_OPTIONS) {
      return `Provide between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`;
    }
    const lowerSet = new Set(trimmedOptions.map((o) => o.toLowerCase()));
    if (lowerSet.size !== trimmedOptions.length) {
      return "All poll options must be unique.";
    }
    return null;
  }, [account, isOnSepolia, optionInputs, questionInput]);

  const handleCreatePollSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formValidationReason || !window.ethereum || createTxStage !== "idle") {
      return;
    }

    const cleanQuestion = questionInput.trim();
    const cleanOptions = optionInputs.map((o) => o.trim());

    try {
      setCreateTxStage("confirm");
      const browserProvider = new BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const writeContract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      const tx = await writeContract.createPoll(cleanQuestion, cleanOptions);
      setCreateTxStage("mining");
      addToast(
        "info",
        "Transaction submitted",
        "Waiting for Sepolia confirmation...",
        tx.hash
      );

      await tx.wait();
      setCreateTxStage("done");
      addToast(
        "success",
        "Poll created on Sepolia!",
        `"${cleanQuestion}" is now live.`,
        tx.hash
      );

      await fetchAllPolls(true);
      await refreshWalletBalance(account);

      window.setTimeout(() => {
        setQuestionInput("");
        setOptionInputs(["", ""]);
        setCreateTxStage("idle");
        navigate("#explore");
      }, 1100);
    } catch (err) {
      setCreateTxStage("idle");
      addToast("error", "Create poll failed", extractErrorMessage(err));
    }
  };

  /* --- Contract Write: Vote (Preserves BrowserProvider signer flow + vote) --- */
  const handleVote = async (pollId: number, optionIndex: number) => {
    if (!account) {
      addToast("info", "Wallet required", "Connect your wallet to vote.");
      navigate("#connect");
      return;
    }
    if (!isOnSepolia) {
      addToast("error", "Wrong network", "Switch to Sepolia before voting.");
      return;
    }
    if (!window.ethereum) return;

    const actionKey = `${pollId}-${optionIndex}`;
    setVotingPollKey(actionKey);

    try {
      const browserProvider = new BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const writeContract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      const tx = await writeContract.vote(pollId, optionIndex);
      addToast(
        "info",
        "Vote broadcast",
        "Confirming your vote on Sepolia...",
        tx.hash
      );

      await tx.wait();
      addToast(
        "success",
        "Vote recorded!",
        `Your vote on Poll #${pollId} is confirmed.`,
        tx.hash
      );

      await fetchAllPolls(true);
      await refreshWalletBalance(account);
    } catch (err) {
      addToast("error", "Vote failed", extractErrorMessage(err));
    } finally {
      setVotingPollKey(null);
    }
  };

  /* --- Copy Helpers --- */
  const handleCopyAddress = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 2000);
    } catch {
      addToast("error", "Copy failed", "Could not access clipboard.");
    }
  };

  const handleSharePoll = async (pollId: number) => {
    const shareUrl = `${window.location.origin}${window.location.pathname}#results/${pollId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setSharedCopied(true);
      window.setTimeout(() => setSharedCopied(false), 2000);
    } catch {
      addToast("error", "Copy failed", "Could not copy share link.");
    }
  };

  /* --- Derived Metrics & Poll Collections --- */
  const totalPollsCount = polls.length;
  const totalVotesCount = useMemo(
    () => polls.reduce((sum, p) => sum + p.totalVotes, 0),
    [polls]
  );

  const animatedPollsCount = useCountUp(totalPollsCount);
  const animatedVotesCount = useCountUp(totalVotesCount);

  const mostPopularPoll: PollData | null = useMemo(() => {
    if (polls.length === 0) return null;
    return polls.reduce(
      (best, current) => (current.totalVotes > best.totalVotes ? current : best),
      polls[0]
    );
  }, [polls]);

  const newestThreePolls: PollData[] = useMemo(() => {
    if (polls.length === 0) return [];
    return [...polls].sort((a, b) => b.id - a.id).slice(0, 3);
  }, [polls]);

  const filterCounts = useMemo(() => {
    const lowerAcc = account?.toLowerCase() ?? "";
    return {
      all: polls.length,
      open: polls.filter((p) => !p.hasVoted).length,
      voted: polls.filter((p) => p.hasVoted).length,
      mine: lowerAcc
        ? polls.filter((p) => p.creator.toLowerCase() === lowerAcc).length
        : 0
    };
  }, [account, polls]);

  const filteredAndSortedPolls = useMemo(() => {
    const lowerAcc = account?.toLowerCase() ?? "";
    const filtered = polls.filter((poll) => {
      if (filterMode === "open") return !poll.hasVoted;
      if (filterMode === "voted") return poll.hasVoted;
      if (filterMode === "mine") {
        return Boolean(lowerAcc) && poll.creator.toLowerCase() === lowerAcc;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortMode === "most_votes") {
        if (b.totalVotes !== a.totalVotes) return b.totalVotes - a.totalVotes;
      }
      return b.id - a.id;
    });
  }, [account, filterMode, polls, sortMode]);

  const activeResultsPoll = useMemo(() => {
    if (route.screen !== "results" || route.pollId === null) return null;
    return polls.find((p) => p.id === route.pollId) ?? null;
  }, [polls, route.pollId, route.screen]);

  const walletActiveStep = useMemo((): 1 | 2 | 3 | 4 => {
    if (!hasMetaMask) return 1;
    if (!account) return 2;
    if (!isOnSepolia) return 3;
    return 4;
  }, [account, hasMetaMask, isOnSepolia]);

  const sampleResultsHash = useMemo(() => {
    if (mostPopularPoll) return `#results/${mostPopularPoll.id}`;
    if (polls.length > 0) return `#results/${polls[0].id}`;
    return "#results/0";
  }, [mostPopularPoll, polls]);

  /* ==========================================================================
     Render
     ========================================================================== */

  return (
    <div ref={shellRef} className="app-shell">
      {/* Layered Fixed Backdrop (Drifting Pastel Blobs + Cursor Spotlight Dot Grid + Linked Squares Motif) */}
      {/* Layered Fixed Backdrop (4 Pastel Blobs + Blueprint & Spotlight Dot Grid + Multi-Track Ledger Motif) */}
      <div className="page-backdrop-layer" aria-hidden="true">
        <div className="bg-blob bg-blob-lime" />
        <div className="bg-blob bg-blob-sky" />
        <div className="bg-blob bg-blob-peach" />
        <div className="bg-blob bg-blob-mint" />

        <div className="bg-blueprint-grid" />
        <div className="bg-dot-grid-base" />
        <div className="bg-dot-grid-spotlight" />

        <svg
          className="bg-chain-motif"
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
        >
          <g stroke="#ffffff" strokeWidth="1.5" fill="none">
            {/* Upper Diagonal Ledger Track */}
            <line x1="-120" y1="620" x2="1560" y2="-40" strokeDasharray="6 6" />
            <g transform="rotate(-21.4 180 502)">
              <rect x="170" y="492" width="20" height="20" rx="4" fill="#070b14" />
              <line x1="175" y1="502" x2="185" y2="502" />
            </g>
            <g transform="rotate(-21.4 460 392)">
              <rect x="450" y="382" width="20" height="20" rx="4" fill="#070b14" />
              <line x1="455" y1="392" x2="465" y2="392" />
            </g>
            <g transform="rotate(-21.4 740 282)">
              <rect x="730" y="272" width="20" height="20" rx="4" fill="#070b14" />
              <line x1="735" y1="282" x2="745" y2="282" />
            </g>
            <g transform="rotate(-21.4 1020 172)">
              <rect x="1010" y="162" width="20" height="20" rx="4" fill="#070b14" />
              <line x1="1015" y1="172" x2="1025" y2="172" />
            </g>
            <g transform="rotate(-21.4 1300 62)">
              <rect x="1290" y="52" width="20" height="20" rx="4" fill="#070b14" />
              <line x1="1295" y1="62" x2="1305" y2="62" />
            </g>

            {/* Lower Parallel Consensus Track */}
            <line x1="-120" y1="860" x2="1560" y2="200" />
            <g transform="rotate(-21.4 110 770)">
              <rect x="100" y="760" width="20" height="20" rx="4" fill="#070b14" />
              <circle cx="110" cy="770" r="2.5" fill="#ffffff" />
            </g>
            <g transform="rotate(-21.4 390 660)">
              <rect x="380" y="650" width="20" height="20" rx="4" fill="#070b14" />
              <circle cx="390" cy="660" r="2.5" fill="#ffffff" />
            </g>
            <g transform="rotate(-21.4 670 550)">
              <rect x="660" y="540" width="20" height="20" rx="4" fill="#070b14" />
              <circle cx="670" cy="550" r="2.5" fill="#ffffff" />
            </g>
            <g transform="rotate(-21.4 950 440)">
              <rect x="940" y="430" width="20" height="20" rx="4" fill="#070b14" />
              <circle cx="950" cy="440" r="2.5" fill="#ffffff" />
            </g>
            <g transform="rotate(-21.4 1230 330)">
              <rect x="1220" y="320" width="20" height="20" rx="4" fill="#070b14" />
              <circle cx="1230" cy="330" r="2.5" fill="#ffffff" />
            </g>

            {/* Cross-Links Between Tracks */}
            <line x1="180" y1="502" x2="390" y2="660" strokeDasharray="3 5" />
            <line x1="740" y1="282" x2="950" y2="440" strokeDasharray="3 5" />
          </g>
        </svg>
      </div>

      {/* Global Wrong-Network Top Banner */}
      {isWrongNetwork && (
        <div className="wrong-network-banner" role="alert">
          <div className="wrong-network-content">
            <span className="banner-indicator" aria-hidden="true" />
            <span>
              Connected to unsupported network (Chain ID {chainId}). Switch to{" "}
              <strong>Sepolia</strong> to vote or create polls.
            </span>
          </div>
          <button
            type="button"
            className="btn-pill btn-ink btn-sm"
            onClick={switchToSepolia}
          >
            Switch to Sepolia
          </button>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="top-nav-wrap">
        <nav className="top-nav" aria-label="Primary Navigation">
          <a
            href="#home"
            className="brand-link"
            aria-label="BallotBox Home"
          >
            <span className="brand-mark" aria-hidden="true">
              <span className="brand-square sq-lime" />
              <span className="brand-square sq-ink" />
            </span>
            <span className="brand-text">BallotBox</span>
          </a>

          <div className="nav-pills" role="tablist" aria-label="App Screens">
            {(
              [
                { id: "home", label: "Home", hash: "#home" },
                { id: "explore", label: "Explore", hash: "#explore" },
                { id: "create", label: "Create", hash: "#create" },
                { id: "connect", label: "Wallet", hash: "#connect" }
              ] as const
            ).map((item) => {
              const isActive =
                route.screen === item.id ||
                (route.screen === "results" && item.id === "explore");
              return (
                <a
                  key={item.id}
                  href={item.hash}
                  className={`nav-pill ${isActive ? "active" : ""}`}
                  aria-current={route.screen === item.id ? "page" : undefined}
                >
                  {item.label}
                </a>
              );
            })}
          </div>

          <div className="nav-wallet-area">
            {account ? (
              <a
                href="#connect"
                className={`wallet-status-pill ${
                  isOnSepolia ? "ok" : "warn"
                }`}
              >
                <span
                  className={`status-dot ${
                    isOnSepolia ? "status-dot-pulse" : "status-dot-warn"
                  }`}
                  aria-hidden="true"
                />
                <span>{shortenAddress(account)}</span>
              </a>
            ) : (
              <button
                type="button"
                className="btn-pill btn-ink"
                onClick={() => navigate("#connect")}
              >
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
      </header>

      {/* Main Content Container */}
      <main
        key={`${route.screen}-${route.pollId ?? ""}`}
        className="main-container screen-fade-up"
      >
        {/* =================================================================
            1. HOME / LANDING SCREEN (#home)
            ================================================================= */}
        {route.screen === "home" && (
          <div className="home-landing-stack">
            {/* Soft Diagonal Color Bands Behind Home Sections (Sage, Mint Tint, Sky Tint) */}
            <div className="home-diagonal-bands" aria-hidden="true">
              <div className="diag-band diag-band-sage" />
              <div className="diag-band diag-band-mint" />
              <div className="diag-band diag-band-sky" />
            </div>

            {/* SECTION 1: Hero with Floating Mock Poll Card */}
            <RevealSection className="home-hero-section" ariaLabel="Hero">
              <div className="bento-card tile-lime home-hero-bento">
                <div className="hero-split-layout">
                  <div className="hero-copy-col">
                    <div className="live-status-chip">
                      <span
                        className="status-dot status-dot-pulse"
                        aria-hidden="true"
                      />
                      <span>Live on Sepolia</span>
                    </div>

                    <h1 className="home-hero-headline">
                      Your voice, Your Vote Immutable
                    </h1>

                    <p className="home-hero-subtitle">
                      Create and vote on community proposals backed directly by
                      an immutable Ethereum smart contract.
                    </p>

                    <div className="home-hero-cta-group">
                      <div className="hero-actions">
                        <a href="#explore" className="btn-pill btn-ink">
                          Explore polls
                        </a>
                        <a href="#create" className="btn-pill btn-outline">
                          Create a poll
                        </a>
                      </div>
                      <p className="hero-micro-note">
                        No sign-up. One wallet, one vote.
                      </p>
                    </div>
                  </div>

                  {/* Floating Mock Poll Card (Static Demo Data, Labeled "Example") */}
                  <div className="hero-mock-col">
                    <div
                      className="floating-mock-card"
                      aria-label="Example poll card"
                    >
                      <div className="mock-card-top">
                        <span className="badge badge-ink">Example</span>
                        <span className="badge badge-mint">245 votes</span>
                      </div>

                      <h2 className="mock-card-title">
                        Which scaling upgrade should ship next?
                      </h2>

                      <div className="mock-bars-stack">
                        {HERO_DEMO_OPTIONS.map((item, idx) => (
                          <div key={idx} className="mock-bar-item">
                            <div className="mock-bar-label-row">
                              <span className="mock-opt-label">
                                {item.label}
                              </span>
                              <span className="mock-opt-pct">{item.pct}%</span>
                            </div>
                            <div className="mock-bar-track">
                              <div
                                className={`mock-bar-fill mock-fill-${idx}`}
                                style={{ width: `${item.pct}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mock-card-footer">
                        <span>Verified on Sepolia</span>
                        <span>1 wallet = 1 vote</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </RevealSection>

            {/* SECTION 2: Live Stats Strip (4 Bento Tiles) */}
            <RevealSection
              className="home-stats-strip"
              ariaLabel="Live Contract Statistics"
            >
              <div className="bento-card tile-sky stat-strip-tile">
                <span className="bento-kicker">Polls created</span>
                <strong className="strip-big-number" aria-live="polite">
                  {animatedPollsCount}
                </strong>
                <span className="meta-muted">Deployed on Sepolia</span>
              </div>

              <div className="bento-card tile-mint stat-strip-tile">
                <span className="bento-kicker">Total votes</span>
                <strong className="strip-big-number" aria-live="polite">
                  {animatedVotesCount}
                </strong>
                <span className="meta-muted">Confirmed on-chain ballots</span>
              </div>

              <div className="bento-card tile-peach stat-strip-tile">
                <div className="card-header-row">
                  <span className="bento-kicker">Most popular poll</span>
                  {mostPopularPoll && (
                    <span className="badge badge-ink">
                      {mostPopularPoll.totalVotes}{" "}
                      {mostPopularPoll.totalVotes === 1 ? "vote" : "votes"}
                    </span>
                  )}
                </div>

                {mostPopularPoll ? (
                  <>
                    <h2 className="popular-poll-title">
                      {mostPopularPoll.question}
                    </h2>
                    <a
                      href={`#results/${mostPopularPoll.id}`}
                      className="inline-text-link"
                    >
                      View poll results
                    </a>
                  </>
                ) : (
                  <>
                    <p className="popular-empty-text">
                      No polls deployed yet on this contract.
                    </p>
                    <a href="#create" className="inline-text-link">
                      Create the first poll
                    </a>
                  </>
                )}
              </div>

              <div className="bento-card tile-surface stat-strip-tile">
                <div className="card-header-row">
                  <span className="bento-kicker">Wallet status</span>
                  <span
                    className={`status-dot ${
                      account && isOnSepolia
                        ? "status-dot-pulse"
                        : account
                        ? "status-dot-warn"
                        : ""
                    }`}
                    aria-hidden="true"
                  />
                </div>

                {account ? (
                  <>
                    <strong className="strip-wallet-addr">
                      {shortenAddress(account)}
                    </strong>
                    <div className="strip-wallet-meta">
                      <span className="badge badge-mint">
                        {isOnSepolia ? "Sepolia Ready" : "Wrong Network"}
                      </span>
                      <a href="#connect" className="inline-text-link">
                        Manage
                      </a>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="popular-empty-text">
                      Connect MetaMask to create polls or cast a vote.
                    </p>
                    <a href="#connect" className="btn-pill btn-ink btn-xs">
                      Connect wallet
                    </a>
                  </>
                )}
              </div>
            </RevealSection>

            {/* SECTION 3: "How it works" */}
            <RevealSection
              className="home-how-section"
              ariaLabel="How it works"
            >
              <div className="section-heading-row">
                <div>
                  <span className="bento-kicker">Simple Workflow</span>
                  <h2 className="home-section-title">How it works</h2>
                </div>
                <span className="badge badge-outline">3 Steps</span>
              </div>

              <div className="how-cards-grid">
                <article className="bento-card tile-surface how-card">
                  <div className="how-card-top">
                    <span className="numbered-badge">01</span>
                    <div className="css-icon css-icon-wallet" aria-hidden="true">
                      <span className="wallet-body" />
                      <span className="wallet-flap" />
                      <span className="wallet-clasp" />
                    </div>
                  </div>
                  <h3 className="how-card-title">Connect MetaMask</h3>
                  <p className="how-card-text">
                    Link your browser wallet and switch to the Sepolia test
                    network in a single click with zero registration.
                  </p>
                </article>

                <article className="bento-card tile-sky how-card">
                  <div className="how-card-top">
                    <span className="numbered-badge">02</span>
                    <div className="css-icon css-icon-ballot" aria-hidden="true">
                      <span className="ballot-line line-w-full" />
                      <span className="ballot-line line-w-mid" />
                      <span className="ballot-plus-v" />
                      <span className="ballot-plus-h" />
                    </div>
                  </div>
                  <h3 className="how-card-title">Create or pick a poll</h3>
                  <p className="how-card-text">
                    Deploy a new question with 2 to 4 options on-chain, or
                    browse open community proposals in the registry.
                  </p>
                </article>

                <article className="bento-card tile-mint how-card">
                  <div className="how-card-top">
                    <span className="numbered-badge">03</span>
                    <div className="css-icon css-icon-chart" aria-hidden="true">
                      <span className="chart-col col-1" />
                      <span className="chart-col col-2" />
                      <span className="chart-col col-3" />
                    </div>
                  </div>
                  <h3 className="how-card-title">
                    Vote once and watch results
                  </h3>
                  <p className="how-card-text">
                    Sign your choice with your wallet and watch the live
                    percentage bars update directly from smart contract state.
                  </p>
                </article>
              </div>
            </RevealSection>

            {/* SECTION 4: "Why on-chain?" */}
            <RevealSection
              className="home-why-section"
              ariaLabel="Why on-chain"
            >
              <div className="section-heading-row">
                <div>
                  <span className="bento-kicker">Trustless Architecture</span>
                  <h2 className="home-section-title">Why on-chain?</h2>
                </div>
                <span className="badge badge-ink">Sepolia EVM</span>
              </div>

              <div className="why-bento-grid">
                <article className="bento-card tile-peach why-tile">
                  <div className="why-tile-header">
                    <span className="why-shape shape-lock" aria-hidden="true" />
                    <h3 className="why-tile-title">Tamper-proof</h3>
                  </div>
                  <p className="why-tile-sentence">
                    Every question, option, and ballot is permanently sealed in
                    Ethereum smart contract storage where nobody can alter or
                    delete it.
                  </p>
                </article>

                <article className="bento-card tile-lime why-tile">
                  <div className="why-tile-header">
                    <span
                      className="why-shape shape-one-vote"
                      aria-hidden="true"
                    />
                    <h3 className="why-tile-title">One wallet one vote</h3>
                  </div>
                  <p className="why-tile-sentence">
                    The contract enforces strict per-address voter tracking so
                    each wallet can cast exactly one ballot per poll.
                  </p>
                </article>

                <article className="bento-card tile-sky why-tile">
                  <div className="why-tile-header">
                    <span
                      className="why-shape shape-public"
                      aria-hidden="true"
                    />
                    <h3 className="why-tile-title">Public results</h3>
                  </div>
                  <p className="why-tile-sentence">
                    Live tallies are readable directly from the public Sepolia
                    RPC at any time without accounts or paywalls.
                  </p>
                </article>

                <article className="bento-card tile-mint why-tile">
                  <div className="why-tile-header">
                    <span
                      className="why-shape shape-verify"
                      aria-hidden="true"
                    />
                    <h3 className="why-tile-title">Verifiable on Etherscan</h3>
                  </div>
                  <p className="why-tile-sentence">
                    Every poll deployment and vote produces a public transaction
                    hash that anyone can audit independently on Sepolia
                    Etherscan.
                  </p>
                </article>
              </div>
            </RevealSection>

            {/* SECTION 5: Latest Polls */}
            <RevealSection
              className="home-latest-section"
              ariaLabel="Latest polls"
            >
              <div className="section-heading-row">
                <div>
                  <span className="bento-kicker">Fresh Proposals</span>
                  <h2 className="home-section-title">Latest polls</h2>
                </div>
                <a href="#explore" className="btn-pill btn-outline btn-xs">
                  View all polls
                </a>
              </div>

              {isLoadingPolls ? (
                <div className="latest-three-grid" aria-busy="true">
                  {[0, 1, 2].map((sk) => (
                    <div
                      key={sk}
                      className="bento-card tile-surface skeleton-card"
                    >
                      <div className="skeleton-line sk-sm" />
                      <div className="skeleton-line sk-lg" />
                      <div className="skeleton-line sk-md" />
                      <div className="skeleton-line sk-md" />
                    </div>
                  ))}
                </div>
              ) : newestThreePolls.length === 0 ? (
                <div className="bento-card tile-sky empty-state-card">
                  <div className="css-illustration" aria-hidden="true">
                    <div className="shape-card-back" />
                    <div className="shape-card-front">
                      <div className="shape-bar shape-bar-1" />
                      <div className="shape-bar shape-bar-2" />
                      <div className="shape-bar shape-bar-3" />
                    </div>
                    <div className="shape-badge-circle">
                      <div className="shape-check" />
                    </div>
                  </div>
                  <h3 className="empty-title">No polls on the contract yet</h3>
                  <p className="empty-desc">
                    Deploy the very first proposal to kick off community voting
                    on Sepolia.
                  </p>
                  <a href="#create" className="btn-pill btn-ink">
                    Create the first poll
                  </a>
                </div>
              ) : (
                <div className="latest-three-grid">
                  {newestThreePolls.map((poll, idx) => {
                    const cardColors = [
                      "tile-surface",
                      "tile-mint",
                      "tile-peach"
                    ];
                    const tileClass = cardColors[idx % cardColors.length];
                    return (
                      <article
                        key={poll.id}
                        className={`bento-card compact-poll-card ${tileClass}`}
                      >
                        <div className="compact-poll-top">
                          <span className="badge badge-ink">
                            Poll #{poll.id}
                          </span>
                          <span className="badge badge-outline">
                            {poll.totalVotes}{" "}
                            {poll.totalVotes === 1 ? "vote" : "votes"}
                          </span>
                        </div>

                        <h3 className="compact-poll-question">
                          {poll.question}
                        </h3>

                        <div className="compact-poll-bars">
                          {poll.options.map((opt, optIdx) => {
                            const count = poll.votes[optIdx] ?? 0;
                            const pct =
                              poll.totalVotes > 0
                                ? Math.round((count / poll.totalVotes) * 100)
                                : 0;
                            return (
                              <div key={optIdx} className="compact-opt-row">
                                <div className="compact-opt-labels">
                                  <span className="truncate-text">{opt}</span>
                                  <span>{pct}%</span>
                                </div>
                                <div className="mini-bar-track">
                                  <div
                                    className="mini-bar-fill"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="compact-poll-footer">
                          <a
                            href={`#results/${poll.id}`}
                            className="inline-text-link"
                          >
                            Results
                          </a>
                          <a
                            href="#explore"
                            className="btn-pill btn-ink btn-xs"
                          >
                            Vote
                          </a>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </RevealSection>

            {/* SECTION 6: Final Call-to-Action Band in Lime */}
            <RevealSection
              className="home-cta-section"
              ariaLabel="Get started call to action"
            >
              <div className="bento-card tile-lime final-cta-band">
                <div className="final-cta-copy">
                  <h2 className="final-cta-headline">
                    Ready to cast your first on-chain vote?
                  </h2>
                  <p className="final-cta-sentence">
                    Connect your Sepolia wallet in seconds to launch a poll or
                    weigh in on active community proposals.
                  </p>
                </div>
                <a
                  href={account ? "#explore" : "#connect"}
                  className="btn-pill btn-ink"
                >
                  Get started
                </a>
              </div>
            </RevealSection>
          </div>
        )}

        {/* =================================================================
            2. WALLET SCREEN (#connect)
            ================================================================= */}
        {route.screen === "connect" && (
          <section className="bento-grid wallet-grid" aria-label="Wallet Setup">
            <div className="bento-card tile-surface wallet-steps-card">
              <div className="card-header-row">
                <span className="bento-kicker">Onboarding Checklist</span>
                <span className="badge badge-ink">
                  {walletActiveStep === 4
                    ? "All Steps Complete"
                    : `Step ${walletActiveStep} of 3`}
                </span>
              </div>
              <h1 className="section-title">Wallet & Network Readiness</h1>
              <p className="section-subtitle">
                Complete the 3 steps below to create proposals and cast votes on
                Sepolia.
              </p>

              <div className="wallet-progress-list">
                <div
                  className={`wallet-step-card ${
                    walletActiveStep === 1
                      ? "step-current"
                      : hasMetaMask
                      ? "step-complete"
                      : ""
                  }`}
                >
                  <div className="step-badge-col">
                    <span className="numbered-badge">1</span>
                  </div>
                  <div className="step-info-col">
                    <div className="step-title-row">
                      <h3>Install MetaMask</h3>
                      <span className="badge badge-outline">
                        {hasMetaMask ? "Installed" : "Current Step"}
                      </span>
                    </div>
                    <p>
                      A browser wallet extension is required to sign Sepolia
                      transactions.
                    </p>
                    {!hasMetaMask && (
                      <a
                        href="https://metamask.io/download/"
                        target="_blank"
                        rel="noreferrer"
                        className="btn-pill btn-ink btn-sm"
                      >
                        Download MetaMask
                      </a>
                    )}
                  </div>
                </div>

                <div
                  className={`wallet-step-card ${
                    walletActiveStep === 2
                      ? "step-current"
                      : account
                      ? "step-complete"
                      : ""
                  }`}
                >
                  <div className="step-badge-col">
                    <span className="numbered-badge">2</span>
                  </div>
                  <div className="step-info-col">
                    <div className="step-title-row">
                      <h3>Connect Wallet</h3>
                      <span className="badge badge-outline">
                        {account
                          ? "Connected"
                          : walletActiveStep === 2
                          ? "Current Step"
                          : "Pending"}
                      </span>
                    </div>
                    <p>
                      Authorize this DApp to view your public address and request
                      signatures.
                    </p>
                    {hasMetaMask && !account && (
                      <button
                        type="button"
                        className="btn-pill btn-ink btn-sm"
                        onClick={connectWallet}
                        disabled={isConnecting}
                      >
                        {isConnecting ? "Connecting..." : "Connect MetaMask"}
                      </button>
                    )}
                  </div>
                </div>

                <div
                  className={`wallet-step-card ${
                    walletActiveStep === 3
                      ? "step-current"
                      : account && isOnSepolia
                      ? "step-complete"
                      : ""
                  }`}
                >
                  <div className="step-badge-col">
                    <span className="numbered-badge">3</span>
                  </div>
                  <div className="step-info-col">
                    <div className="step-title-row">
                      <h3>Switch to Sepolia</h3>
                      <span className="badge badge-outline">
                        {account && isOnSepolia
                          ? "On Sepolia"
                          : walletActiveStep === 3
                          ? "Current Step"
                          : "Pending"}
                      </span>
                    </div>
                    <p>
                      All voting smart contract calls run on Sepolia (Chain ID{" "}
                      {SEPOLIA_CHAIN_ID}).
                    </p>
                    {account && !isOnSepolia && (
                      <button
                        type="button"
                        className="btn-pill btn-ink btn-sm"
                        onClick={switchToSepolia}
                      >
                        Switch to Sepolia
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="wallet-side-stack">
              <div className="bento-card tile-sky wallet-detail-card">
                <span className="bento-kicker">Session Details</span>
                {account ? (
                  <>
                    <div className="address-box">
                      <span className="address-label">Connected Address</span>
                      <div className="address-copy-row">
                        <code className="address-full">{account}</code>
                        <button
                          type="button"
                          className="btn-pill btn-ink btn-sm"
                          onClick={handleCopyAddress}
                          aria-label="Copy wallet address"
                        >
                          {copiedAddress ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    </div>

                    <div className="wallet-metrics-row">
                      <div className="wallet-metric-box">
                        <span className="meta-muted">Sepolia Balance</span>
                        <strong className="metric-big">{balanceEth} ETH</strong>
                      </div>
                      <div className="wallet-metric-box">
                        <span className="meta-muted">Network</span>
                        <strong className="metric-big">
                          {isOnSepolia ? "Sepolia" : `Chain #${chainId ?? "?"}`}
                        </strong>
                      </div>
                    </div>

                    <div className="wallet-action-row">
                      <button
                        type="button"
                        className="btn-pill btn-outline btn-sm"
                        onClick={() => void refreshWalletBalance(account)}
                      >
                        Refresh Balance
                      </button>
                      <button
                        type="button"
                        className="btn-pill btn-outline btn-sm"
                        onClick={disconnectWallet}
                      >
                        Disconnect
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="wallet-disconnected-box">
                    <p>
                      No wallet connected yet. Connect MetaMask to view your
                      address and Sepolia ETH balance.
                    </p>
                    <button
                      type="button"
                      className="btn-pill btn-ink"
                      onClick={connectWallet}
                      disabled={!hasMetaMask || isConnecting}
                    >
                      {isConnecting ? "Requesting..." : "Connect Wallet"}
                    </button>
                  </div>
                )}
              </div>

              {account && isZeroBalance && (
                <div
                  className="bento-card tile-peach balance-warning-card"
                  role="status"
                >
                  <span className="bento-kicker">Zero Balance Warning</span>
                  <h2 className="warning-title">You have 0 Sepolia ETH</h2>
                  <p className="warning-desc">
                    Creating polls and casting votes require a tiny amount of
                    test ETH for gas. Claim free Sepolia ETH from a public
                    faucet before submitting a transaction.
                  </p>
                  <a
                    href={SEPOLIA_FAUCET_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-pill btn-ink btn-sm"
                  >
                    Get Free Sepolia ETH Faucet
                  </a>
                </div>
              )}
            </div>
          </section>
        )}

        {/* =================================================================
            3. CREATE POLL SCREEN (#create)
            ================================================================= */}
        {route.screen === "create" && (
          <section className="bento-grid create-grid" aria-label="Create a Poll">
            <form
              className="bento-card tile-surface create-form-card"
              onSubmit={handleCreatePollSubmit}
              noValidate
            >
              <div className="card-header-row">
                <span className="bento-kicker">New Proposal</span>
                <span className="badge badge-lime">On-Chain Poll</span>
              </div>
              <h1 className="section-title">Create a Poll</h1>
              <p className="section-subtitle">
                Define your question (max {QUESTION_MAX_LENGTH} chars) and{" "}
                {MIN_OPTIONS} to {MAX_OPTIONS} options (max {OPTION_MAX_LENGTH}{" "}
                chars each). Once deployed, the poll is immutable on Sepolia.
              </p>

              <div className="field-group">
                <div className="field-label-row">
                  <label htmlFor="poll-question-input" className="field-label">
                    Poll Question
                  </label>
                  <span
                    className={`char-counter ${
                      questionInput.length > QUESTION_MAX_LENGTH ? "over" : ""
                    }`}
                  >
                    {questionInput.length}/{QUESTION_MAX_LENGTH}
                  </span>
                </div>
                <input
                  id="poll-question-input"
                  type="text"
                  className="text-input"
                  placeholder="e.g., Which upgrade should ship in Q3?"
                  maxLength={QUESTION_MAX_LENGTH}
                  value={questionInput}
                  onChange={(e) => setQuestionInput(e.target.value)}
                  disabled={createTxStage !== "idle"}
                />
              </div>

              <div className="field-group">
                <div className="field-label-row">
                  <span className="field-label">
                    Poll Options ({optionInputs.length}/{MAX_OPTIONS})
                  </span>
                  {optionInputs.length < MAX_OPTIONS && (
                    <button
                      type="button"
                      className="btn-pill btn-outline btn-xs"
                      onClick={() =>
                        setOptionInputs((prev) => [...prev, ""])
                      }
                      disabled={createTxStage !== "idle"}
                    >
                      + Add Option
                    </button>
                  )}
                </div>

                <div className="options-inputs-stack">
                  {optionInputs.map((optVal, idx) => (
                    <div key={idx} className="option-input-item">
                      <div className="field-label-row">
                        <label
                          htmlFor={`poll-option-${idx}`}
                          className="option-sub-label"
                        >
                          Option {idx + 1}
                        </label>
                        <span
                          className={`char-counter ${
                            optVal.length > OPTION_MAX_LENGTH ? "over" : ""
                          }`}
                        >
                          {optVal.length}/{OPTION_MAX_LENGTH}
                        </span>
                      </div>
                      <div className="option-input-row">
                        <input
                          id={`poll-option-${idx}`}
                          type="text"
                          className="text-input"
                          placeholder={`Option ${idx + 1}`}
                          maxLength={OPTION_MAX_LENGTH}
                          value={optVal}
                          onChange={(e) => {
                            const val = e.target.value;
                            setOptionInputs((prev) =>
                              prev.map((item, i) => (i === idx ? val : item))
                            );
                          }}
                          disabled={createTxStage !== "idle"}
                        />
                        {optionInputs.length > MIN_OPTIONS && (
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Remove option ${idx + 1}`}
                            onClick={() =>
                              setOptionInputs((prev) =>
                                prev.filter((_, i) => i !== idx)
                              )
                            }
                            disabled={createTxStage !== "idle"}
                          >
                            x
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="tx-progress-box" aria-live="polite">
                <span className="tx-progress-heading">Transaction Progress</span>
                <div className="tx-steps-row">
                  {(
                    [
                      { key: "confirm", label: "1. Confirm in wallet" },
                      { key: "mining", label: "2. Mining" },
                      { key: "done", label: "3. Done" }
                    ] as const
                  ).map((step) => {
                    const order = ["idle", "confirm", "mining", "done"];
                    const currentIdx = order.indexOf(createTxStage);
                    const stepIdx = order.indexOf(step.key);
                    const isCurrent = createTxStage === step.key;
                    const isCompleted =
                      currentIdx > stepIdx || createTxStage === "done";

                    return (
                      <div
                        key={step.key}
                        className={`tx-step-pill ${
                          isCurrent
                            ? "tx-current"
                            : isCompleted
                            ? "tx-complete"
                            : ""
                        }`}
                      >
                        <span>{step.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="submit-row">
                {formValidationReason ? (
                  <span className="validation-reason" role="status">
                    {formValidationReason}
                  </span>
                ) : (
                  <span className="validation-ready">
                    Ready to deploy to Sepolia
                  </span>
                )}
                <button
                  type="submit"
                  className="btn-pill btn-ink"
                  disabled={
                    Boolean(formValidationReason) || createTxStage !== "idle"
                  }
                >
                  {createTxStage === "confirm"
                    ? "Confirm in Wallet..."
                    : createTxStage === "mining"
                    ? "Mining on Sepolia..."
                    : createTxStage === "done"
                    ? "Done!"
                    : "Deploy Poll"}
                </button>
              </div>
            </form>

            <aside
              className="bento-card tile-mint live-preview-card"
              aria-label="Live Poll Preview"
            >
              <div className="card-header-row">
                <span className="bento-kicker">Live Preview</span>
                <span className="badge badge-ink">Interactive Card</span>
              </div>

              <div
                key={`${questionInput}-${optionInputs.join("|")}`}
                className="preview-inner-card preview-pulse"
              >
                <div className="poll-card-badges">
                  <span className="badge badge-peach">Your poll</span>
                  <span className="badge badge-sky">Preview</span>
                </div>

                <h2 className="preview-question">
                  {questionInput.trim() || "Your poll question will appear here..."}
                </h2>

                <div className="preview-options-list">
                  {optionInputs.map((opt, idx) => (
                    <div key={idx} className="preview-option-pill">
                      <span className="preview-option-index">#{idx + 1}</span>
                      <span className="preview-option-text">
                        {opt.trim() || `Option ${idx + 1}`}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="preview-footer">
                  <span>
                    Creator: {account ? shortenAddress(account) : "0xYour...Addr"}
                  </span>
                  <span>{optionInputs.length} Options</span>
                </div>
              </div>
            </aside>
          </section>
        )}

        {/* =================================================================
            4. EXPLORE SCREEN (#explore)
            ================================================================= */}
        {route.screen === "explore" && (
          <section className="explore-section" aria-label="Explore Polls">
            <div className="bento-card tile-surface explore-toolbar">
              <div className="explore-title-area">
                <span className="bento-kicker">On-Chain Registry</span>
                <h1 className="section-title">Explore Polls</h1>
              </div>

              <div className="explore-controls-row">
                <div
                  className="filter-chips-group"
                  role="group"
                  aria-label="Filter polls"
                >
                  {(
                    [
                      { id: "all", label: "All", count: filterCounts.all },
                      {
                        id: "open",
                        label: "Open to me",
                        count: filterCounts.open
                      },
                      { id: "voted", label: "Voted", count: filterCounts.voted },
                      {
                        id: "mine",
                        label: "My polls",
                        count: filterCounts.mine
                      }
                    ] as const
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      className={`filter-chip ${
                        filterMode === chip.id ? "active" : ""
                      }`}
                      onClick={() => setFilterMode(chip.id)}
                    >
                      <span>{chip.label}</span>
                      <span className="chip-count">{chip.count}</span>
                    </button>
                  ))}
                </div>

                <div className="sort-control">
                  <label htmlFor="explore-sort-select" className="sort-label">
                    Sort by
                  </label>
                  <select
                    id="explore-sort-select"
                    className="sort-select"
                    aria-label="Sort polls"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                  >
                    <option value="newest">Newest</option>
                    <option value="most_votes">Most votes</option>
                  </select>
                </div>
              </div>
            </div>

            {isLoadingPolls ? (
              <div className="explore-cards-grid" aria-busy="true">
                {[0, 1, 2].map((sk) => (
                  <div key={sk} className="bento-card tile-surface skeleton-card">
                    <div className="skeleton-line sk-sm" />
                    <div className="skeleton-line sk-lg" />
                    <div className="skeleton-line sk-md" />
                    <div className="skeleton-line sk-md" />
                  </div>
                ))}
              </div>
            ) : filteredAndSortedPolls.length === 0 ? (
              <div className="bento-card tile-sky empty-state-card">
                <div className="css-illustration" aria-hidden="true">
                  <div className="shape-card-back" />
                  <div className="shape-card-front">
                    <div className="shape-bar shape-bar-1" />
                    <div className="shape-bar shape-bar-2" />
                    <div className="shape-bar shape-bar-3" />
                  </div>
                  <div className="shape-badge-circle">
                    <div className="shape-check" />
                  </div>
                </div>
                <h2 className="empty-title">No matching polls found</h2>
                <p className="empty-desc">
                  {polls.length === 0
                    ? "Be the first to deploy a proposal to the Sepolia smart contract."
                    : "Try switching filter chips above or deploy a brand new poll."}
                </p>
                <div className="empty-actions">
                  {filterMode !== "all" && (
                    <button
                      type="button"
                      className="btn-pill btn-outline"
                      onClick={() => setFilterMode("all")}
                    >
                      Show All Polls
                    </button>
                  )}
                  <a href="#create" className="btn-pill btn-ink">
                    Create a Poll
                  </a>
                </div>
              </div>
            ) : (
              <div className="explore-cards-grid">
                {filteredAndSortedPolls.map((poll, cardIdx) => {
                  const isMine =
                    Boolean(account) &&
                    poll.creator.toLowerCase() === account?.toLowerCase();
                  const leaderInfo = getPollStatusLeader(poll);
                  const tileThemes = [
                    "tile-surface",
                    "tile-mint",
                    "tile-sky",
                    "tile-peach"
                  ];
                  const cardTheme = tileThemes[cardIdx % tileThemes.length];

                  return (
                    <article
                      key={poll.id}
                      className={`bento-card poll-explore-card ${cardTheme}`}
                    >
                      <div className="poll-card-badges">
                        <span className="badge badge-ink">#{poll.id}</span>
                        {poll.hasVoted && (
                          <span className="badge badge-lime">Voted</span>
                        )}
                        {isMine && (
                          <span className="badge badge-peach">Your poll</span>
                        )}
                        <span className="badge badge-outline">
                          {leaderInfo.status === "leading"
                            ? `Leading: ${leaderInfo.leaderText}`
                            : leaderInfo.leaderText}
                        </span>
                      </div>

                      <h2 className="poll-card-question">{poll.question}</h2>

                      <div className="poll-card-options">
                        {poll.options.map((opt, optIdx) => {
                          const count = poll.votes[optIdx] ?? 0;
                          const pct =
                            poll.totalVotes > 0
                              ? Math.round((count / poll.totalVotes) * 100)
                              : 0;
                          const isThisVoting =
                            votingPollKey === `${poll.id}-${optIdx}`;

                          return (
                            <div key={optIdx} className="explore-option-block">
                              <button
                                type="button"
                                className={`explore-option-btn ${
                                  poll.hasVoted ? "voted-locked" : ""
                                }`}
                                disabled={
                                  poll.hasVoted || votingPollKey !== null
                                }
                                onClick={() => void handleVote(poll.id, optIdx)}
                              >
                                <span className="explore-opt-name">{opt}</span>
                                <span className="explore-opt-action">
                                  {isThisVoting
                                    ? "Voting..."
                                    : poll.hasVoted
                                    ? `${count} (${pct}%)`
                                    : "Vote"}
                                </span>
                              </button>

                              {poll.hasVoted && (
                                <div
                                  className="mini-bar-track"
                                  aria-label={`${opt}: ${pct}%`}
                                >
                                  <div
                                    className="mini-bar-fill"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="poll-card-footer">
                        <span className="meta-muted">
                          {poll.totalVotes}{" "}
                          {poll.totalVotes === 1 ? "vote" : "votes"} • By{" "}
                          {shortenAddress(poll.creator)}
                        </span>
                        <a
                          href={`#results/${poll.id}`}
                          className="btn-pill btn-ink btn-xs"
                        >
                          Results
                        </a>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* =================================================================
            5. RESULTS SCREEN (#results/<id>)
            ================================================================= */}
        {route.screen === "results" && (
          <section className="results-section" aria-label="Poll Results">
            {isLoadingPolls ? (
              <div className="bento-card tile-surface skeleton-card">
                <div className="skeleton-line sk-sm" />
                <div className="skeleton-line sk-lg" />
                <div className="skeleton-line sk-md" />
              </div>
            ) : !activeResultsPoll ? (
              <div className="bento-card tile-peach empty-state-card">
                <h1 className="section-title">Poll Not Found</h1>
                <p className="section-subtitle">
                  We couldn&apos;t find Poll #{route.pollId ?? "?"} on this
                  contract.
                </p>
                <a href="#explore" className="btn-pill btn-ink">
                  Back to Explore
                </a>
              </div>
            ) : (
              (() => {
                const leaderInfo = getPollStatusLeader(activeResultsPoll);

                return (
                  <div className="results-bento-stack">
                    <div className="bento-card tile-lime results-header-card">
                      <div className="results-top-bar">
                        <div className="results-badges-row">
                          <a href="#explore" className="btn-pill btn-outline btn-xs">
                            Back to Explore
                          </a>
                          <span className="badge badge-ink">
                            Poll #{activeResultsPoll.id}
                          </span>
                          {leaderInfo.status === "leading" && (
                            <span className="badge badge-sky">
                              Leading: {leaderInfo.leaderText}
                            </span>
                          )}
                          {leaderInfo.status === "tie" && (
                            <span className="badge badge-peach">Tie</span>
                          )}
                          {leaderInfo.status === "none" && (
                            <span className="badge badge-outline">
                              No votes yet
                            </span>
                          )}
                          {activeResultsPoll.hasVoted && (
                            <span className="badge badge-mint">You Voted</span>
                          )}
                        </div>

                        <div className="results-utility-btns">
                          <span className="last-updated-label" aria-live="polite">
                            Last updated {secondsSinceUpdate}s ago
                          </span>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Refresh poll results"
                            onClick={() => void fetchAllPolls(false)}
                          >
                            R
                          </button>
                          <button
                            type="button"
                            className="btn-pill btn-ink btn-xs"
                            onClick={() =>
                              void handleSharePoll(activeResultsPoll.id)
                            }
                          >
                            {sharedCopied ? "Link copied" : "Share"}
                          </button>
                        </div>
                      </div>

                      <h1 className="results-title">
                        {activeResultsPoll.question}
                      </h1>
                    </div>

                    <div className="results-summary-row">
                      <div className="bento-card tile-surface summary-metric-card">
                        <span className="meta-muted">Total Votes</span>
                        <strong className="summary-metric-val">
                          {activeResultsPoll.totalVotes}
                        </strong>
                      </div>

                      <div className="bento-card tile-sky summary-metric-card">
                        <span className="meta-muted">Leading Option</span>
                        <strong className="summary-metric-val truncate-text">
                          {leaderInfo.leaderText}
                        </strong>
                      </div>

                      <div className="bento-card tile-mint summary-metric-card">
                        <span className="meta-muted">Option Count</span>
                        <strong className="summary-metric-val">
                          {activeResultsPoll.options.length}
                        </strong>
                      </div>

                      <div className="bento-card tile-peach summary-metric-card">
                        <span className="meta-muted">Creator</span>
                        <a
                          href={`${ETHERSCAN_BASE_URL}/address/${activeResultsPoll.creator}`}
                          target="_blank"
                          rel="noreferrer"
                          className="creator-etherscan-link"
                        >
                          {shortenAddress(activeResultsPoll.creator)}
                        </a>
                      </div>
                    </div>

                    <div className="bento-card tile-surface results-bars-card">
                      <div className="card-header-row">
                        <span className="bento-kicker">Ballot Breakdown</span>
                        <span className="meta-muted">
                          {activeResultsPoll.hasVoted
                            ? "Your vote is recorded on-chain"
                            : "Select an option below to cast your vote"}
                        </span>
                      </div>

                      <div className="results-bars-list">
                        {activeResultsPoll.options.map((opt, idx) => {
                          const count = activeResultsPoll.votes[idx] ?? 0;
                          const pct =
                            activeResultsPoll.totalVotes > 0
                              ? Math.round(
                                  (count / activeResultsPoll.totalVotes) * 100
                                )
                              : 0;
                          const isTop =
                            leaderInfo.leadingIndices.includes(idx) &&
                            activeResultsPoll.totalVotes > 0;
                          const isThisVoting =
                            votingPollKey === `${activeResultsPoll.id}-${idx}`;

                          return (
                            <div
                              key={idx}
                              className={`result-bar-item ${
                                isTop ? "result-bar-leader" : ""
                              }`}
                            >
                              <div className="result-bar-header">
                                <div className="result-option-title-wrap">
                                  <span className="result-option-name">
                                    {opt}
                                  </span>
                                  {isTop &&
                                    leaderInfo.status === "leading" && (
                                      <span className="badge badge-lime">
                                        Leading
                                      </span>
                                    )}
                                  {isTop && leaderInfo.status === "tie" && (
                                    <span className="badge badge-peach">
                                      Tie
                                    </span>
                                  )}
                                </div>

                                <div className="result-option-stats">
                                  <strong>{pct}%</strong>
                                  <span className="meta-muted">
                                    ({count} {count === 1 ? "vote" : "votes"})
                                  </span>
                                  {!activeResultsPoll.hasVoted && (
                                    <button
                                      type="button"
                                      className="btn-pill btn-ink btn-xs"
                                      disabled={votingPollKey !== null}
                                      onClick={() =>
                                        void handleVote(
                                          activeResultsPoll.id,
                                          idx
                                        )
                                      }
                                    >
                                      {isThisVoting ? "Voting..." : "Vote"}
                                    </button>
                                  )}
                                </div>
                              </div>

                              <div className="result-bar-track">
                                <div
                                  className={`result-bar-fill ${
                                    isTop ? "fill-leader" : ""
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()
            )}
          </section>
        )}
      </main>

      {/* Global Toast Stack with Progress Bar & Etherscan Link */}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-card toast-${toast.type}`}>
            <div className="toast-top">
              <strong>{toast.title}</strong>
              <button
                type="button"
                className="icon-btn toast-close"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                x
              </button>
            </div>
            <p className="toast-msg">{toast.message}</p>
            {toast.txHash && (
              <a
                href={`${ETHERSCAN_BASE_URL}/tx/${toast.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="toast-etherscan-link"
              >
                View on Etherscan
              </a>
            )}
            <div className="toast-progress-track" aria-hidden="true">
              <div className="toast-progress-bar" />
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-brand-col">
            <a href="#home" className="brand-link">
              <span className="brand-mark" aria-hidden="true">
                <span className="brand-square sq-lime" />
                <span className="brand-square sq-ink" />
              </span>
              <span className="brand-text">BallotBox</span>
            </a>
            <div className="footer-contract-row">
              <span
                className="status-dot status-dot-pulse"
                aria-hidden="true"
              />
              <span>Contract:</span>
              <a
                href={`${ETHERSCAN_BASE_URL}/address/${CONTRACT_ADDRESS}`}
                target="_blank"
                rel="noreferrer"
                className="footer-etherscan-link"
              >
                {shortenAddress(CONTRACT_ADDRESS)} (Sepolia Etherscan)
              </a>
            </div>
          </div>

          <nav className="footer-screen-links" aria-label="Footer Screen Links">
            <a href="#home" className="footer-nav-link">
              Home
            </a>
            <a href="#connect" className="footer-nav-link">
              Connect
            </a>
            <a href="#create" className="footer-nav-link">
              Create
            </a>
            <a href="#explore" className="footer-nav-link">
              Explore
            </a>
            <a href={sampleResultsHash} className="footer-nav-link">
              Results
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
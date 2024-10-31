import { ipfs, json, Bytes, log, JSONValue, JSONValueKind } from '@graphprotocol/graph-ts/index';
import {
  STATUS_ACTIVE,
  STATUS_CANCELED,
  STATUS_EXECUTED,
  STATUS_PENDING,
  STATUS_QUEUED,
  NA,
} from '../utils/constants';
import { Proposal, Vote, Executor } from '../../generated/schema';
import { IExecutor } from '../../generated/PegasysGovernanceV2/IExecutor';
import { GovernanceStrategy } from '../../generated/PegasysGovernanceV2/GovernanceStrategy';
import {
  ProposalCreated,
  VoteEmitted,
  ProposalQueued,
  ProposalExecuted,
  ProposalCanceled,
  ExecutorAuthorized,
  ExecutorUnauthorized,
} from '../../generated/PegasysGovernanceV2/PegasysGovernanceV2';
import { getOrInitProposal, getOrInitDelegate } from '../helpers/initializers';

function getProposal(proposalId: string, fn: string): Proposal | null {
  let proposal = Proposal.load(proposalId);
  if (proposal == null) {
    log.error('{}: invalid proposal id {}', [fn, proposalId]);
  }
  return proposal;
}

export function handleProposalCreated(event: ProposalCreated): void {
  let hash = Bytes.fromHexString('1220' + event.params.ipfsHash.toHexString().slice(2)).toBase58();
  let data = ipfs.cat(hash);
  let proposalData = json.try_fromBytes(data as Bytes);
  let title: JSONValue | null = null;
  let shortDescription: JSONValue | null = null;
  let description: JSONValue | null = null;
  let author: JSONValue | null = null;
  let aipNumber: JSONValue | null = null;
  let discussions: JSONValue | null = null;

  if (proposalData.isOk && proposalData.value.kind == JSONValueKind.OBJECT) {
    let data = proposalData.value.toObject();
    title = data.get('title');
    description = data.get('description');
    shortDescription = data.get('shortDescription');
    author = data.get('author');
    discussions = data.get('discussions');
    aipNumber = data.get('aip');
  }

  let proposal = getOrInitProposal(event.params.id.toString());

  if (title && !title.isNull()) {
    proposal.title = title.toString();
  }
  if (author && !author.isNull()) {
    proposal.author = author.toString();
  }
  if (discussions && !discussions.isNull() && discussions.kind == JSONValueKind.STRING) {
    proposal.discussions = discussions.toString();
  }
  if (aipNumber && !aipNumber.isNull() && aipNumber.kind == JSONValueKind.NUMBER) {
    proposal.aipNumber = aipNumber.toBigInt();
  }
  if (shortDescription && !shortDescription.isNull()) {
    proposal.shortDescription = shortDescription.toString();
  }
  if (description && !description.isNull()) {
    proposal.description = description.toString();
  }

  let govStrategyInst = GovernanceStrategy.bind(event.params.strategy);
  proposal.totalPropositionSupply = govStrategyInst.getTotalPropositionSupplyAt(
    event.params.startBlock
  );
  proposal.totalVotingSupply = govStrategyInst.getTotalVotingSupplyAt(event.params.startBlock);

  proposal.govContract = event.address;
  let creator = getOrInitDelegate(event.params.creator.toHexString());
  creator.numProposals = creator.numProposals + 1;
  creator.save();
  proposal.user = creator.id;
  proposal.executor = event.params.executor.toHexString();

  // Fix the targets conversion
  let targets: Bytes[] = [];
  for (let i = 0; i < event.params.targets.length; i++) {
    targets.push(event.params.targets[i] as Bytes);
  }
  proposal.targets = targets;

  proposal.values = event.params.values;
  proposal.signatures = event.params.signatures;
  proposal.calldatas = event.params.calldatas;
  proposal.withDelegatecalls = event.params.withDelegatecalls;
  proposal.startBlock = event.params.startBlock;
  proposal.endBlock = event.params.endBlock;
  proposal.state = event.block.number >= proposal.startBlock ? STATUS_ACTIVE : STATUS_PENDING;
  proposal.governanceStrategy = event.params.strategy;
  proposal.ipfsHash = hash;
  proposal.lastUpdateBlock = event.block.number;
  proposal.timestamp = event.block.timestamp.toI32();
  proposal.createdBlockNumber = event.block.number;
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.save();
}

export function handleProposalQueued(event: ProposalQueued): void {
  let proposal = getProposal(event.params.id.toString(), 'ProposalQueued');
  if (proposal) {
    proposal.state = STATUS_QUEUED;
    proposal.executionTime = event.params.executionTime;
    proposal.initiatorQueueing = event.params.initiatorQueueing;
    proposal.lastUpdateBlock = event.block.number;
    proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
    proposal.save();
  }
}

export function handleProposalExecuted(event: ProposalExecuted): void {
  let proposal = getProposal(event.params.id.toString(), 'ProposalExecuted');
  if (proposal) {
    proposal.state = STATUS_EXECUTED;
    proposal.initiatorExecution = event.params.initiatorExecution;
    proposal.lastUpdateBlock = event.block.number;
    proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
    proposal.save();
  }
}

export function handleProposalCanceled(event: ProposalCanceled): void {
  let proposal = getProposal(event.params.id.toString(), 'ProposalCanceled');
  if (proposal) {
    proposal.state = STATUS_CANCELED;
    proposal.lastUpdateBlock = event.block.number;
    proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
    proposal.save();
  }
}

export function handleVoteEmitted(event: VoteEmitted): void {
  let proposal = getProposal(event.params.id.toString(), 'handleVoteEmitted');
  if (proposal) {
    let support = event.params.support;
    let votingPower = event.params.votingPower;
    if (support) {
      proposal.currentYesVote = proposal.currentYesVote.plus(votingPower);
    } else {
      proposal.currentNoVote = proposal.currentNoVote.plus(votingPower);
    }
    proposal.totalCurrentVoters = proposal.totalCurrentVoters + 1;
    proposal.lastUpdateBlock = event.block.number;
    proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
    proposal.state = STATUS_ACTIVE;
    proposal.save();
  }

  let voterDel = getOrInitDelegate(event.params.voter.toHexString(), false);

  if (voterDel == null) {
    log.error('Delegate {} not found on VoteCast. tx_hash: {}', [
      event.params.voter.toHexString(),
      event.transaction.hash.toHexString(),
    ]);
    // Create new delegate if it doesn't exist
    voterDel = getOrInitDelegate(event.params.voter.toHexString());
  }

  voterDel.numVotes = voterDel.numVotes + 1;
  voterDel.save();

  // Create new Vote entity
  let id = event.params.voter.toHexString() + ':' + event.params.id.toString();
  let vote = new Vote(id);
  vote.proposal = event.params.id.toString();
  vote.support = event.params.support;
  vote.user = voterDel.id;
  vote.votingPower = event.params.votingPower;
  vote.timestamp = event.block.timestamp.toI32();
  vote.save();
}

export function handleExecutorAuthorized(event: ExecutorAuthorized): void {
  let executor = Executor.load(event.params.executor.toHexString());
  if (executor) {
    executor.authorized = true;
  } else {
    executor = new Executor(event.params.executor.toHexString());
    let executorContract = IExecutor.bind(event.params.executor);
    executor.authorized = true;
    executor.propositionThreshold = executorContract.PROPOSITION_THRESHOLD();
    executor.votingDuration = executorContract.VOTING_DURATION();
    executor.voteDifferential = executorContract.VOTE_DIFFERENTIAL();
    executor.gracePeriod = executorContract.GRACE_PERIOD();
    executor.minimumQuorum = executorContract.MINIMUM_QUORUM();
    executor.executionDelay = executorContract.getDelay();
    executor.admin = executorContract.getAdmin();
    executor.pendingAdmin = executorContract.getPendingAdmin();
    executor.authorizationBlock = event.block.number;
    executor.authorizationTimestamp = event.block.timestamp;
  }
  executor.save();
}

export function handleExecutorUnauthorized(event: ExecutorUnauthorized): void {
  let executor = Executor.load(event.params.executor.toHexString());
  if (executor) {
    executor.authorized = false;
    executor.save();
  }
}

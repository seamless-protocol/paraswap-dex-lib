import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { Log, Logger } from '../../types';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { PoolState } from './types';

export class SeamlessProtocolEventPool extends StatefulEventSubscriber<PoolState> {
  private readonly enabled: boolean;

  addressesSubscribed: string[];

  constructor(
    readonly parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    // Phase 1: event pool is intentionally unused. Use an empty interface so
    // SeamlessProtocol can be instantiated without requiring an ABI.
    protected seamlessProtocolIface = new Interface([]), // TODO: add any additional params required for event subscriber
  ) {
    // Phase 1: explicitly disabled to avoid noisy log parsing if wired accidentally.
    super(parentName, 'SeamlessProtocolEventPool(DISABLED)', dexHelper, logger);
    this.enabled = false;
    this.addressesSubscribed = [];
  }

  /**
   * The function is called every time any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    _state: DeepReadonly<PoolState>,
    _log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    if (!this.enabled) return null;
    return null;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenerate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subscriber at blocknumber
   */
  async generateState(_blockNumber: number): Promise<DeepReadonly<PoolState>> {
    // Phase 1: disabled.
    return {} as PoolState;
  }
}

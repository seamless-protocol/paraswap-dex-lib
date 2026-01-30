import { DexConfigMap } from '../../types';
import { Network } from '../../constants';
import {
  SeamlessCore,
  SeamlessPeriphery,
  SeamlessLeverageToken,
  DexParams,
} from './types';

const DEX_KEY = 'SeamlessProtocol';

const MAINNET_SEAMLESS_CORE: SeamlessCore = {
  leverageManager: '0x5C37EB148D4a261ACD101e2B997A0F163Fb3E351',
  multicallExecutor: '0x16D02Ebd89988cAd1Ce945807b963aB7A9Fd22E1',
};
const MAINNET_SEAMLESS_PERIPHERY: SeamlessPeriphery = {
  leverageRouter: '0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA',
  // leverageDexRouter: '0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA', // TODO: replace once LeverageDexRouter is deployed
};
// const MAINNET_SEAMLESS_sUSDS_USDT_25x = {};
// const MAINNET_SEAMLESS_SIUSD_USDC_11x = {};
// const MAINNET_SEAMLESS_RLP_USDC_6_75x = {};
const MAINNET_SEAMLESS_WSTETH_ETH_25x: SeamlessLeverageToken = {
  leverageToken: '0xCE937010b7E55dA282E6161f7Aa4744A0B732035',
  collateralToken: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  debtToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};
// const MAINNET_SEAMLESS_WSTETH_WETH_2x_COW = {};
// const BASE_SEAMLESS_CORE = {};
// const BASE_SEAMLESS_PERIPHERY = {};
// const BASE_SEAMLESS_WEETH_WETH_17x = {};

export const SeamlessProtocolConfig: DexConfigMap<DexParams> = {
  [DEX_KEY]: {
    [Network.MAINNET]: {
      marketsByLeverageToken: {
        ['0xCE937010b7E55dA282E6161f7Aa4744A0B732035'.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_WSTETH_ETH_25x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
      },
    },
  },
};

import { DexConfigMap } from '../../types';
import { Network } from '../../constants';
import {
  SeamlessCore,
  SeamlessPeriphery,
  SeamlessLeverageToken,
  DexParams,
} from './types';

const DEX_KEY = 'SeamlessProtocol';

// Phase 1 Gate 1 venue target: DexLeverageRouter (recipient-aware wrapper around LeverageRouter.deposit).
const DEX_LEVERAGE_ROUTER = '0x03926d5E64aF50b575fDba4B490863dDf26bEd58';
// const DEX_LEVERAGE_ROUTER = '0x0966646b319c450f4842ad352cb7b7a102fd145a'; // previous mainnet deployment

const MAINNET_SEAMLESS_CORE: SeamlessCore = {
  leverageManager: '0x5C37EB148D4a261ACD101e2B997A0F163Fb3E351',
};
const MAINNET_SEAMLESS_PERIPHERY: SeamlessPeriphery = {
  multicallExecutor: '0x16D02Ebd89988cAd1Ce945807b963aB7A9Fd22E1',
  leverageRouter: '0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA',
  dexLeverageRouter: DEX_LEVERAGE_ROUTER,
};
const MAINNET_SEAMLESS_sUSDS_USDT_25x: SeamlessLeverageToken = {
  leverageToken: '0xc73CE54dBC4A02D7110F69AdF123B3DbE5B3033f',
  collateralToken: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  debtToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
};
const MAINNET_SEAMLESS_SIUSD_USDC_11x: SeamlessLeverageToken = {
  leverageToken: '0x604d37747f3382fA51519e7542d54F1e730B97A3',
  collateralToken: '0xDBDC1Ef57537E34680B898E1FEBD3D68c7389bCB',
  debtToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};
const MAINNET_SEAMLESS_RLP_USDC_6_75x: SeamlessLeverageToken = {
  leverageToken: '0x6426811fF283Fa7c78F0BC5D71858c2f79c0Fc3d',
  collateralToken: '0x4956b52aE2fF65D74CA2d61207523288e4528f96',
  debtToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};
const MAINNET_SEAMLESS_WSTETH_ETH_25x: SeamlessLeverageToken = {
  leverageToken: '0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3',
  collateralToken: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  debtToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};
const MAINNET_SEAMLESS_WSTETH_WETH_2x_COW: SeamlessLeverageToken = {
  leverageToken: '0xCE937010b7E55dA282E6161f7Aa4744A0B732035',
  collateralToken: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  debtToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};
const BASE_SEAMLESS_CORE: SeamlessCore = {
  leverageManager: '0xeb0221bf6cdaa74c94129771d5b0c9a994bb2b7c',
};
const BASE_SEAMLESS_PERIPHERY: SeamlessPeriphery = {
  multicallExecutor: '0x9d04f65b58ced1fddef50aec8b0b3d64fe64220e',
  leverageRouter: '0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA',
  // dexLeverageRouter: TODO (not deployed on Base yet)
};
const BASE_SEAMLESS_WEETH_WETH_17x: SeamlessLeverageToken = {
  leverageToken: '0xA2fceEAe99d2cAeEe978DA27bE2d95b0381dBB8c',
  collateralToken: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
  debtToken: '0x4200000000000000000000000000000000000006',
};

export const SeamlessProtocolConfig: DexConfigMap<DexParams> = {
  [DEX_KEY]: {
    [Network.MAINNET]: {
      marketsByLeverageToken: {
        [MAINNET_SEAMLESS_sUSDS_USDT_25x.leverageToken.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_sUSDS_USDT_25x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
        [MAINNET_SEAMLESS_SIUSD_USDC_11x.leverageToken.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_SIUSD_USDC_11x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
        [MAINNET_SEAMLESS_RLP_USDC_6_75x.leverageToken.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_RLP_USDC_6_75x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
        [MAINNET_SEAMLESS_WSTETH_ETH_25x.leverageToken.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_WSTETH_ETH_25x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
        [MAINNET_SEAMLESS_WSTETH_WETH_2x_COW.leverageToken.toLowerCase()]: {
          seamlessCore: MAINNET_SEAMLESS_CORE,
          seamlessPeriphery: MAINNET_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: MAINNET_SEAMLESS_WSTETH_WETH_2x_COW,
          enableSellMint: true,
          enableSellRedeem: false,
        },
      },
    },
    [Network.BASE]: {
      marketsByLeverageToken: {
        [BASE_SEAMLESS_WEETH_WETH_17x.leverageToken.toLowerCase()]: {
          seamlessCore: BASE_SEAMLESS_CORE,
          seamlessPeriphery: BASE_SEAMLESS_PERIPHERY,
          seamlessLeverageToken: BASE_SEAMLESS_WEETH_WETH_17x,
          enableSellMint: true,
          enableSellRedeem: false,
        },
      },
    },
  },
};

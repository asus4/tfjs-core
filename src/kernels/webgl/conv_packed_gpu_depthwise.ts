/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {Conv2DInfo} from '../../ops/conv_util';
import {GPGPUProgram} from './gpgpu_math';

export class DepthwiseConv2DPackedProgram implements GPGPUProgram {
  variableNames = ['x', 'W'];
  usesPackedTextures = true;
  outputShape: number[];
  userCode: string;

  constructor(convInfo: Conv2DInfo) {
    this.outputShape = convInfo.outShape;

    const xNumRows = convInfo.inHeight;
    const xNumCols = convInfo.inWidth;
    const padTop = convInfo.padInfo.top;
    const padLeft = convInfo.padInfo.left;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const channelMul = convInfo.outChannels / convInfo.inChannels;

    let mainLoop = ``;
    for(let i=0; i<4; i++) {
      let coords = `coords = tlCoords;`;
      let getX = `getChannel(getX(batch, xR, xC, d1), vec2(xC, d1))`;
      let getW = `getChannel(getW(wR, wC, d1, q), vec2(d1, q))`;

      if(channelMul === 1) {
        if(i % 2 === 0) {
          getW = `getW(wR, wC, d1, q).x`;
        } else {
          getW = `getW(wR, wC, d1, q).z`;
        }
      }

      if(i % 2 === 1) {
        coords += `coords.w += 1;`;
      }
      if(i > 1) {
        coords += `coords.z += 1;`;
      }

      let innerLoop = ``;

      for(let j=0; j<filterHeight * filterWidth; j++) {
        let wR = Math.floor(j / filterWidth);
        let wC = j % filterWidth;

        if(channelMul === 1) {
          if((wC * dilationWidth) % 2 === 0) { // wC * dilationWidth is even
            if(padLeft % 2 === 0) {
              if(i <= 1 || (strideWidth % 2 === 0)) { // coords.z * strides is even
                // xCCorner is even
                // xC is even
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).r`;
                } else {
                  getX = `getX(batch, xR, xC, d1).g`;
                }
              } else { // coords.z * strides is odd
                // xCCorner is odd
                // xC is odd
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).b`;
                } else {
                  getX = `getX(batch, xR, xC, d1).a`;
                }
              }
            } else {
              if(i <= 1 || (strideWidth % 2 === 0)) { // coords.z * strides is even
                // xCCorner is odd
                // xC is odd
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).b`;
                } else {
                  getX = `getX(batch, xR, xC, d1).a`;
                }
              } else { // coords.z * strides is odd
                // xCCorner is even
                // xC is even
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).r`;
                } else {
                  getX = `getX(batch, xR, xC, d1).g`;
                }
              }
            }
          } else { // wC * dilationWidth is odd
            if(padLeft % 2 === 0) {
              if(i <= 1 || (strideWidth % 2 === 0)) { // coords.z * strides is even
                // xCCorner is even
                // xC is odd
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).b`;
                } else {
                  getX = `getX(batch, xR, xC, d1).a`;
                }
              } else { // coords.z * strides is odd
                // xCCorner is odd
                // xC is even
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).r`;
                } else {
                  getX = `getX(batch, xR, xC, d1).g`;
                }
              }
            } else {
              if(i <= 1 || (strideWidth % 2 === 0)) { // coords.z * strides is even
                // xCCorner is odd
                // xC is even
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).r`;
                } else {
                  getX = `getX(batch, xR, xC, d1).g`;
                }
              } else { // coords.z * strides is odd
                // xCCorner is even
                // xC is odd
                if(i % 2 === 0) {
                  getX = `getX(batch, xR, xC, d1).b`;
                } else {
                  getX = `getX(batch, xR, xC, d1).a`;
                }
              }
            }
          }
        }

        innerLoop += `
          wR = ${wR};
          wC = ${wC};

          xR = xRCorner + wR * ${dilationHeight};

          if(xR >= 0 && xR < ${xNumRows}) {
            xC = xCCorner + wC * ${dilationWidth};

            if(xC >= 0 && xC < ${xNumCols}) {
              float xVal = ${getX};
              float wVal = ${getW};

              dotProd += xVal * wVal;
            }
          }
        `;
      }

      mainLoop += `
        ${coords}
        ${i > 0 ? `if(coords.z < ${this.outputShape[2]} && coords.w < ${this.outputShape[3]}) {` : ''}
          ivec2 xRCCorner = ivec2(coords.y, coords.z) * strides - pads;
          int d2 = coords.w;
          int d1 = d2 / ${channelMul};
          int q = d2 - d1 * ${channelMul};

          int xRCorner = xRCCorner.x;
          int xCCorner = xRCCorner.y;

          float dotProd = 0.0;
          int wR;
          int wC;
          int xR;
          int xC;

          ${innerLoop}

          result[${i}] = dotProd;
        ${i > 0 ? '}' : ''}
      `;
    }

    this.userCode = `
      const ivec2 strides = ivec2(${strideHeight}, ${strideWidth});
      const ivec2 pads = ivec2(${padTop}, ${padLeft});

      void main() {
        vec4 result = vec4(0);
        ivec4 tlCoords = getOutputCoords();
        int batch = tlCoords.x;

        ivec4 coords;

        ${mainLoop}

        setOutput(result);
      }
    `;
  }
}
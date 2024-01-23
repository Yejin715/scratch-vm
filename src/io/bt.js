const JSONRPC = require('../util/jsonrpc');

class BT extends JSONRPC {

    /**
     * A BT peripheral socket object.  It handles connecting, over web sockets, to
     * BT peripherals, and reading and writing data to them.
     * @param {Runtime} runtime - the Runtime for sending/receiving GUI update events.
     * @param {string} extensionId - the id of the extension using this socket.
     * @param {object} peripheralOptions - the list of options for peripheral discovery.
     * @param {object} connectCallback - a callback for connection.
     * @param {object} resetCallback - a callback for resetting extension state.
     * @param {object} messageCallback - a callback for message sending.
     */
    constructor (runtime, extensionId, peripheralOptions, connectCallback, resetCallback = null, messageCallback) {
        super();

        this._socket = runtime.getScratchLinkSocket('BT');
        this._socket.setOnOpen(this.requestPeripheral.bind(this));
        this._socket.setOnError(this._handleRequestError.bind(this));
        this._socket.setOnClose(this.handleDisconnectError.bind(this));
        this._socket.setHandleMessage(this._handleMessage.bind(this));

        this._sendMessage = this._socket.sendMessage.bind(this._socket);

        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._connected = false;
        this._characteristicDidChangeCallback = null;
        this._resetCallback = resetCallback;
        this._discoverTimeoutID = null;
        this._extensionId = extensionId;
        this._extensionName = '';  // 새로 추가한 변수
        this._peripheralOptions = peripheralOptions;
        this._messageCallback = messageCallback;
        this._runtime = runtime;

        this._socket.open();
    }

    /**
     * Request connection to the peripheral.
     * If the web socket is not yet open, request when the socket promise resolves.
     */
    requestPeripheral () {
        this._availablePeripherals = {};
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._discoverTimeoutID = window.setTimeout(this._handleDiscoverTimeout.bind(this), 15000);
        this.sendRemoteRequest('discover', this._peripheralOptions)
            .catch(
                e => this._handleRequestError(e)
            );
    }

    /**
     * Try connecting to the input peripheral id, and then call the connect
     * callback if connection is successful.
     * @param {number} id - the id of the peripheral to connect to
     * @param {string} pin - an optional pin for pairing
     */
    connectPeripheral (id, pin = null) {
        const peripheral = this._availablePeripherals[id];
        if (!peripheral) {
            console.log("peripheral err :", peripheral);
            return; // 해당 아이디에 맞는 장치가 없으면 종료
        }
    
        const peripheralName = peripheral.name;
        console.log("peripheralName :", peripheralName);
        if (peripheralName.startsWith('iCOBOT-')) {
            const match = peripheralName.match(/\d+/); // 정규표현식을 사용하여 숫자 추출
            console.log("match:", match);
            if (match) {
                const extractedNumber = match[0];
                const generatedPin = extractedNumber.repeat(2); // 숫자를 2번 반복하여 PIN 생성
                console.log("Generated PIN:", generatedPin);
    
                const params = {peripheralId: id, pin: generatedPin};
                this.sendRemoteRequest('connect', params)
                    .then(() => {
                        this._connected = true;
                        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                        this._connectCallback();
                        // 연결이 성공했을 때 추가로 수행할 작업을 여기에 추가
                        console.log("Bluetooth connection successful!");
                    })
                    .catch(e => {
                        console.log("Bluetooth connection fall!");
                        this._handleRequestError(e);
                    });
            } else {
                console.log("Failed to extract number from peripheral name");
            }
        } else {
            console.log("Peripheral name does not match the expected pattern");
        }
    }

    /**
     * Close the websocket.
     */
    disconnect () {
        if (this._connected) {
            this._connected = false;
        }

        if (this._socket.isOpen()) {
            this._socket.close();
        }

        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }

        // Sets connection status icon to orange
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
    }

    /**
     * @return {bool} whether the peripheral is connected.
     */
    isConnected () {
        return this._connected;
    }

    sendMessage (options) {
        return this.sendRemoteRequest('send', options)
            .catch(e => {
                this.handleDisconnectError(e);
            });
    }

    /**
     * Handle a received call from the socket.
     * @param {string} method - a received method label.
     * @param {object} params - a received list of parameters.
     * @return {object} - optional return value.
     */
    didReceiveCall (method, params) {
        // TODO: Add peripheral 'undiscover' handling
        switch (method) {
        case 'didDiscoverPeripheral':
            this._availablePeripherals[params.peripheralId] = params;
            this._extensionName = params.name;  // params.name을 _extensionName 변수에 저장
            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this._availablePeripherals
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'userDidPickPeripheral':
            this._availablePeripherals[params.peripheralId] = params;
            this._extensionName = params.name;  // params.name을 _extensionName 변수에 저장
            this._runtime.emit(
                this._runtime.constructor.USER_PICKED_PERIPHERAL,
                this._availablePeripherals
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'userDidNotPickPeripheral':
            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'didReceiveMessage':
            this._messageCallback(params); // TODO: refine?
            console.log("Bt params : ", params);
            break;
        default:
            return 'nah';
        }
    }

    /**
     * Handle an error resulting from losing connection to a peripheral.
     *
     * This could be due to:
     * - battery depletion
     * - going out of bluetooth range
     * - being powered down
     *
     * Disconnect the socket, and if the extension using this socket has a
     * reset callback, call it. Finally, emit an error to the runtime.
     */
    handleDisconnectError (/* e */) {
        // log.error(`BT error: ${JSON.stringify(e)}`);

        if (!this._connected) return;

        this.disconnect();

        if (this._resetCallback) {
            this._resetCallback();
        }

        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
            message: `Scratch lost connection to`,
            extensionId: this._extensionId
        });
    }

    _handleRequestError (/* e */) {
        // log.error(`BT error: ${JSON.stringify(e)}`);

        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message: `Scratch lost connection to`,
            extensionId: this._extensionId
        });
    }

    _handleDiscoverTimeout () {
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT);
    }
}

module.exports = BT;

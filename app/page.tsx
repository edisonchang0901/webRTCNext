"use client";
import { useRef, useState } from 'react';
import { Role, SignalingClient } from "amazon-kinesis-video-streams-webrtc";
import AWS from 'aws-sdk';


export default function Home() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const recordedChunks = useRef<Blob[]>([]);
  const accessKeyId = "";
  const secretAccessKey = "";
  const region = "ap-northeast-1";
  const channelARN = "";
  
  const handleMasterStreaming = async () => {
    // 用於儲存viewer的ID
    let remoteId = '';
    const kinesisVideoClient = new AWS.KinesisVideo({
      region,
      accessKeyId,
      secretAccessKey,
      correctClockSkew: true,
      apiVersion: 'latest'
    });

    const endpoints = await kinesisVideoClient.getSignalingChannelEndpoint({
      ChannelARN: channelARN,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: ['WSS', 'HTTPS'],
        Role: 'MASTER',
      },
    }).promise();


    const httpsEndpoint = endpoints.ResourceEndpointList?.find(x => x.Protocol === 'HTTPS')?.ResourceEndpoint;
    const wssEndpoint = endpoints.ResourceEndpointList?.find(x => x.Protocol === 'WSS')?.ResourceEndpoint;
    console.log("Signaling Channel httpsEndpoint:", httpsEndpoint);
    console.log("Signaling Channel wssEndpoint:", wssEndpoint);
    const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
      region,
      accessKeyId,
      secretAccessKey,
      endpoint: httpsEndpoint,
      correctClockSkew: true,
    });

    const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
      .getIceServerConfig({
        ChannelARN: channelARN,
      }).promise();

    const iceServers: RTCIceServer[] = [
      { urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` },
      ...(getIceServerConfigResponse.IceServerList || []).map(ice => ({
        urls: ice.Uris!,
        username: ice.Username,
        credential: ice.Password,
      })),
    ];

    const peerConnection = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
    });

    const signalingClient = new SignalingClient({
      channelARN,
      channelEndpoint: wssEndpoint as string,
      role: Role.MASTER,
      region,
      credentials: { accessKeyId, secretAccessKey },
      systemClockOffset: 0,
    });

    signalingClient.on('open', async () => {
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });

      // 顯示畫面
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      // 將本地的媒體資料流加入到 RTCPeerConnection，進行共享
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });

      setLocalStream(localStream);
    });

    signalingClient.on('sdpOffer', async (offer, remoteClientId) => {
    console.warn('[master] get sdp offer')
    remoteId = remoteClientId;
    await peerConnection.setRemoteDescription(offer);
    await peerConnection.setLocalDescription(
      await peerConnection.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      }),
    );

      // 接到發話端的 SDP offer 後，進行 SDP answer 的回應
      // 將 SDP answer 回應給 viewer 端
      console.warn('[master] send sdp answer')
      signalingClient.sendSdpAnswer(peerConnection.localDescription as RTCSessionDescription, remoteId);
    });

    signalingClient.on('close', () => {
      console.log('close');
    });

    signalingClient.on('error', error => {
      console.log('error', error);
    });

    // 本地端的 RTCPeerConnection 產生 ICE 候選後，透過 signalingClient 傳送給發話端
    peerConnection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        console.warn('[master] send iceCandidate')
        console.log(candidate)
        signalingClient.sendIceCandidate(candidate, remoteId);
      } else {
        console.log('No more ICE candidates will be generated')
      }
    });

    peerConnection.ontrack = event => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = event.streams[0];
    }};

    signalingClient.open();

  };

  const handleViewStreaming = async () => {
   
    const clientId = Math.floor(Math.random() * 999999).toString();
    const kinesisVideoClient = new AWS.KinesisVideo({
      region: region,
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
      correctClockSkew: true,
      apiVersion: 'latest'
    });
    const endpoints = await kinesisVideoClient.getSignalingChannelEndpoint({
      ChannelARN: channelARN,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: ['WSS', 'HTTPS'],
        Role: 'VIEWER',
      },
    }).promise();

    const httpsEndpoint = endpoints.ResourceEndpointList?.find(x => x.Protocol === 'HTTPS')?.ResourceEndpoint;
    const wssEndpoint = endpoints.ResourceEndpointList?.find(x => x.Protocol === 'WSS')?.ResourceEndpoint;
    console.log("Signaling Channel httpsEndpoint:", httpsEndpoint);
    console.log("Signaling Channel wssEndpoint:", wssEndpoint);

    const signalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
      region,
      accessKeyId,
      secretAccessKey,
      endpoint: httpsEndpoint!,
      correctClockSkew: true,
    });

    const { IceServerList } = await signalingChannelsClient
      .getIceServerConfig({
        ChannelARN: channelARN
      }).promise();

    const iceServers = [
      { urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` },
      ...(IceServerList || []).map(ice => ({
        urls: ice.Uris!,
        username: ice.Username,
        credential: ice.Password,
      })),
    ];

    const peerConnection = new RTCPeerConnection({ iceServers });

    const signalingClient = new SignalingClient({
      channelARN,
      channelEndpoint: wssEndpoint!,
      role: Role.VIEWER,
      clientId,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      },
      systemClockOffset: 0,
    });

    // 啟動與 AWS Kinesis Video Streams Signaling Service 的 WebSocket 連線
    signalingClient.on('open', async () => {

      const localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });

      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      await peerConnection.setLocalDescription(offer);

      signalingClient.sendSdpOffer(peerConnection.localDescription as RTCSessionDescription);
    });

    // 透過「SDP 協商」交換彼此的能力資訊
    signalingClient.on('sdpAnswer', async (sdpAnswer) => {
      console.warn('[viewer] get sdp answer')

      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
    });

    // 處理 ICE 候選者
    signalingClient.on('iceCandidate', async (candidate) => {
      console.warn('[viewer] get ice candidate', candidate);

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    });

    signalingClient.on('close', () => {
      console.log('close');
    });

     signalingClient.on('error', error => {
      console.log('error', error);
    });

    peerConnection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        console.warn('[viewer] send iceCandidate')
        signalingClient.sendIceCandidate(candidate);
      } else {
        console.log('No more ICE candidates will be generated')
      }
    });

    peerConnection.ontrack = event => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = event.streams[0];
    }};
    signalingClient.open();
  };


  const startRecording = () => {
    if (!localStream || isRecording) return;

    const recorder = new MediaRecorder(localStream, { mimeType: "video/webm; codecs=vp9" });
    setMediaRecorder(recorder);
    setIsRecording(true);

    // 每次資料可用時，就呼叫上傳
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        uploadChunk(event.data); // 分段上傳
      }
    };

    recorder.onstop = async () => {
      // 停止時只是重設狀態
      setIsRecording(false);
    };
    
    recorder.start(10000);  
  };

  const stopRecording = () => {
    mediaRecorder?.stop();
  };

 const uploadChunk = async (blob: Blob) => {
  const formData = new FormData();
  formData.append("file", blob, `chunk_${Date.now()}.webm`);

  await fetch("http://host.docker.internal:8000/api/upload", {
    method: "POST",
    body: formData,
  });
};



  return (
  <div>
    <button 
      onClick={handleMasterStreaming} 
      style={{ padding: '10px 20px', marginBottom: '10px' }}>
      Start Master
    </button>
    <button
      onClick={handleViewStreaming}
      style={{ padding: '10px 20px', marginBottom: '10px' }}>
      Start Viewer
    </button>
      <div style={{ marginTop: '10px' }}>
        <p>📷 Local Stream</p>
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          style={{ width: '500px', height: '200px', border: '1px solid black' }}
        />
      </div>
      <div style={{ marginTop: '10px' }}>
        <p>🛰️ Remote Stream</p>
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{ width: '500px', height: '200px', border: '1px solid red' }}
        />
    </div>
       <button onClick={startRecording} disabled={isRecording} style={{ padding: '10px 20px', marginBottom: '10px', backgroundColor: isRecording ? '#ccc' : '#10b981', color: 'white', border: 'none', borderRadius: '5px' }}>Start Recording</button>
       <button onClick={stopRecording} style={{ padding: '10px 20px', marginBottom: '10px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '5px' }}>Stop & Upload</button>
  </div>
    
  );
};
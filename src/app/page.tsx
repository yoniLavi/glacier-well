"use client";

import RAPIER, { type Collider, type EventQueue, type ImpulseJoint, type RigidBody, type World } from "@dimforge/rapier2d-compat";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const ARENA = 34;
const SCALE = 11;
const VIEW = 800;
const BLOCK = .88;
const SHIP_NOSE = 2.2;
const SHIP_RADIUS = 1.25;
const LAUNCH_SPEED = 20;
const ICE_COLOR = "#9aaab2";
const MANTLE_COLORS = ["#68737a", "#7b776f", "#59656b", "#827d73"];
const SHAPES = [
  [[-1, 0], [0, 0], [1, 0], [2, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[-1, 0], [0, 0], [1, 0], [0, 1]],
  [[-1, 1], [0, 1], [0, 0], [1, 0]],
  [[-1, 0], [0, 0], [0, 1], [1, 1]],
  [[-1, 0], [-1, 1], [0, 1], [1, 1]],
  [[1, 0], [-1, 1], [0, 1], [1, 1]],
];

type Block = {
  body: RigidBody | null; collider: Collider | null; color: string; group: number;
  attached: boolean; removed: boolean; settledOnce: boolean; born: number; variant: number;
  local?: { x: number; y: number }; localRotation?: number;
};
type Group = { id: number; blocks: Block[]; joints: ImpulseJoint[]; fractured: boolean };
type Absorption = { blocks: Block[]; started: number; duration: number };
type Sim = {
  world: World; events: EventQueue; core: RigidBody; coreCollider: Collider; planetRadius: number;
  ship: RigidBody; shipCollider: Collider;
  mantles: Array<{ inner: number; outer: number; color: string }>; blocks: Block[]; groups: Group[];
  escapedGroups: Set<number>;
  nextShape: number; payloadReadyAt: number; invulnerableUntil: number;
  score: number; rings: number; escapes: number; shots: number; over: boolean; paused: boolean;
  lastTime: number; accumulator: number; groupId: number; flash: number; message: string; absorption: Absorption | null;
};
type HUD = { ready: boolean; score: number; rings: number; escapes: number; shipSpeed: number; clearance: number; drift: number; bandCharge: number; planetRadius: number; message: string; over: boolean; paused: boolean; absorbing: boolean; nextShape: number; payloadReady: boolean; shielded: boolean };

const initialHUD: HUD = { ready: false, score: 0, rings: 0, escapes: 0, shipSpeed: 0, clearance: 20, drift: 0, bandCharge: 0, planetRadius: 3.1, message: "Cooling the gravity well…", over: false, paused: false, absorbing: false, nextShape: 2, payloadReady: false, shielded: false };
const rotate = (x: number, y: number, angle: number) => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
const screen = (x: number, y: number) => ({ x: VIEW / 2 + x * SCALE, y: VIEW / 2 + y * SCALE });
const gravityStrength = (radius: number) => 3.2 * Math.tanh(radius / 5) + 1.05 * radius * Math.exp(-(radius * radius) / (2 * 22 * 22));
const shipTransform = (sim: Sim, shape = SHAPES[sim.nextShape]) => {
  const position = sim.ship.translation(); const direction = sim.ship.rotation();
  const rearOffset = Math.min(...shape.map(([x]) => x * BLOCK * 2.05)); const payloadDistance = SHIP_NOSE + BLOCK * 1.25 - rearOffset;
  return { position, direction, muzzle: { x: position.x + Math.cos(direction) * payloadDistance, y: position.y + Math.sin(direction) * payloadDistance } };
};

function traceIce(ctx: CanvasRenderingContext2D, size: number, variant: number) {
  ctx.beginPath();
  if (variant === 0) { ctx.moveTo(-size * .9, -size * .68); ctx.quadraticCurveTo(-size * .2, -size, size * .55, -size * .92); ctx.quadraticCurveTo(size, -size * .4, size * .94, -size * .25); ctx.lineTo(size * .72, size * .82); ctx.quadraticCurveTo(0, size * 1.05, -size * .38, size * .96); ctx.lineTo(-size * .92, size * .35); ctx.closePath(); }
  else if (variant === 1) { ctx.moveTo(-size * .7, -size * .94); ctx.quadraticCurveTo(0, -size * .82, size * .62, -size * .78); ctx.lineTo(size * .96, size * .18); ctx.quadraticCurveTo(size * .7, size, size * .42, size * .94); ctx.lineTo(-size * .72, size * .78); ctx.quadraticCurveTo(-size, size * .3, -size * .96, -size * .12); ctx.closePath(); }
  else { ctx.moveTo(-size * .88, -size * .45); ctx.lineTo(-size * .25, -size * .95); ctx.quadraticCurveTo(size * .4, -size, size * .76, -size * .72); ctx.lineTo(size * .92, size * .55); ctx.quadraticCurveTo(size * .6, size, size * .12, size * .96); ctx.lineTo(-size * .82, size * .62); ctx.closePath(); }
}

function blockPose(block: Block, core: RigidBody) {
  if (block.body) return { position: block.body.translation(), rotation: block.body.rotation() };
  const local = block.local ?? { x: 0, y: 0 }; const spun = rotate(local.x, local.y, core.rotation()); const center = core.translation();
  return { position: { x: center.x + spun.x, y: center.y + spun.y }, rotation: core.rotation() + (block.localRotation ?? 0) };
}

function captureField(sim: Sim) {
  const inner = sim.planetRadius + .25; const outer = sim.planetRadius + 4.1; const middle = (inner + outer) / 2;
  return { inner, outer, middle, sectors: 72 };
}

function atmosphereCoverage(sim: Sim) {
  const occupied = new Set<number>();
  const field = captureField(sim);
  const center = sim.core.translation();
  sim.blocks.filter((block) => block.attached && !block.removed).forEach((block) => {
    const position = blockPose(block, sim.core).position; const dx = position.x - center.x; const dy = position.y - center.y; const radius = Math.hypot(dx, dy);
    if (radius < field.inner || radius >= field.outer) return;
    const centerSector = ((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * field.sectors;
    const halfSpan = Math.max(1, Math.ceil(Math.asin(Math.min(.95, BLOCK * 1.08 / radius)) / (Math.PI * 2) * field.sectors));
    for (let offset = -halfSpan; offset <= halfSpan; offset++) occupied.add((Math.floor(centerSector) + offset + field.sectors) % field.sectors);
  });
  let largestGap = 0; let currentGap = 0;
  for (let i = 0; i < field.sectors * 2; i++) {
    if (occupied.has(i % field.sectors)) currentGap = 0;
    else { currentGap++; largestGap = Math.max(largestGap, Math.min(currentGap, field.sectors)); }
  }
  const gapDegrees = largestGap * 360 / field.sectors;
  return { occupied, gapDegrees, complete: occupied.size > 0 && gapDegrees <= 30, charge: Math.max(0, Math.min(1, (360 - gapDegrees) / 330)) };
}

function bandCharge(sim: Sim) {
  return atmosphereCoverage(sim).charge;
}

function compressedPlanetRadius(radius: number, blockCount: number) {
  const compressedArea = blockCount * Math.pow(BLOCK * 2, 2) * .32;
  const areaRadius = Math.sqrt(radius * radius + compressedArea / Math.PI);
  return radius + Math.max(.35, Math.min(.8, areaRadius - radius));
}

function unfreezeBlock(sim: Sim, block: Block, now: number, velocityBoost = { x: 0, y: 0 }) {
  if (!block.attached || !block.collider) return;
  const pose = blockPose(block, sim.core); const corePosition = sim.core.translation(); const coreVelocity = sim.core.linvel(); const coreOmega = sim.core.angvel();
  const dx = pose.position.x - corePosition.x; const dy = pose.position.y - corePosition.y;
  sim.world.removeCollider(block.collider, true);
  const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pose.position.x, pose.position.y).setRotation(pose.rotation)
    .setLinvel(coreVelocity.x - coreOmega * dy + velocityBoost.x, coreVelocity.y + coreOmega * dx + velocityBoost.y).setAngvel(coreOmega).setLinearDamping(.12).setAngularDamping(.18).setCcdEnabled(true));
  const collider = sim.world.createCollider(iceCollider(block.variant).setDensity(.85).setFriction(1).setRestitution(.08)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(28), body);
  block.body = body; block.collider = collider; block.attached = false; block.local = undefined; block.localRotation = undefined; block.born = now;
}

function releaseDisconnectedIce(sim: Sim, now: number) {
  const attached = sim.blocks.filter((block) => block.attached && block.local && block.collider);
  const connected = new Set<Block>();
  attached.forEach((block) => { if (Math.hypot(block.local!.x, block.local!.y) < sim.planetRadius + BLOCK * 1.55) connected.add(block); });
  let changed = true;
  while (changed) {
    changed = false;
    attached.forEach((candidate) => {
      if (connected.has(candidate)) return;
      for (const anchor of connected) {
        if (Math.hypot(candidate.local!.x - anchor.local!.x, candidate.local!.y - anchor.local!.y) < BLOCK * 2.55) {
          connected.add(candidate); changed = true; break;
        }
      }
    });
  }

  attached.filter((block) => !connected.has(block)).forEach((block) => unfreezeBlock(sim, block, now));
}

function iceCollider(variant: number, size = BLOCK) {
  const shapes = [
    [-.9, -.68, .55, -.92, .94, -.25, .72, .82, -.38, .96, -.92, .35],
    [-.7, -.94, .62, -.78, .96, .18, .42, .94, -.72, .78, -.96, -.12],
    [-.88, -.45, -.25, -.95, .76, -.72, .92, .55, .12, .96, -.82, .62],
  ];
  const points = new Float32Array(shapes[variant % shapes.length].map((value) => value * size));
  return RAPIER.ColliderDesc.roundConvexHull(points, size * .16) ?? RAPIER.ColliderDesc.roundCuboid(size, size, size * .35);
}

function launchPayload(sim: Sim, launchSpeed: number, fractured = false, now = performance.now()) {
  if (sim.over || sim.paused || sim.absorption || now < sim.payloadReadyAt) return false;
  const shapeIndex = sim.nextShape; const shape = SHAPES[shapeIndex];
  const { direction, muzzle } = shipTransform(sim); const shipVelocity = sim.ship.linvel();
  const group: Group = { id: ++sim.groupId, blocks: [], joints: [], fractured };
  shape.forEach(([gx, gy], blockIndex) => {
    const offset = rotate(gx * BLOCK * 2.05, gy * BLOCK * 2.05, direction);
    const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(muzzle.x + offset.x, muzzle.y + offset.y).setRotation(direction)
      .setLinvel(shipVelocity.x + Math.cos(direction) * launchSpeed, shipVelocity.y + Math.sin(direction) * launchSpeed)
      .setLinearDamping(.12).setAngularDamping(.18).setCcdEnabled(true));
    const variant = (group.id + blockIndex) % 3;
    const collider = sim.world.createCollider(iceCollider(variant).setDensity(.85).setFriction(1).setRestitution(.08)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(28), body);
    const block: Block = { body, collider, color: ICE_COLOR, group: group.id, attached: false, removed: false, settledOnce: false, born: now, variant };
    group.blocks.push(block); sim.blocks.push(block);
  });
  if (!fractured) for (let i = 0; i < shape.length; i++) for (let j = i + 1; j < shape.length; j++) {
    const dx = shape[j][0] - shape[i][0]; const dy = shape[j][1] - shape[i][1];
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    const anchorA = rotate(dx * BLOCK * 1.025, dy * BLOCK * 1.025, 0);
    group.joints.push(sim.world.createImpulseJoint(RAPIER.JointData.fixed(anchorA, 0, { x: -anchorA.x, y: -anchorA.y }, 0), group.blocks[i].body!, group.blocks[j].body!, true));
  }
  sim.groups.push(group); sim.shots++; sim.nextShape = (shapeIndex + 1 + Math.floor(Math.random() * 3)) % SHAPES.length;
  return true;
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim | null>(null);
  const keysRef = useRef(new Set<string>());
  const frameRef = useRef(0);
  const [hud, setHud] = useState<HUD>(initialHUD);
  const [revision, setRevision] = useState(0);

  const syncHUD = useCallback((sim: Sim) => setHud({
    ready: true, score: sim.score, rings: sim.rings, escapes: sim.escapes,
    shipSpeed: Math.hypot(sim.ship.linvel().x, sim.ship.linvel().y),
    clearance: Math.max(0, Math.hypot(sim.ship.translation().x - sim.core.translation().x, sim.ship.translation().y - sim.core.translation().y) - sim.planetRadius - SHIP_RADIUS),
    drift: Math.hypot(sim.core.translation().x, sim.core.translation().y) / 25.5, bandCharge: bandCharge(sim), planetRadius: sim.planetRadius,
    message: sim.message,
    over: sim.over, paused: sim.paused, absorbing: Boolean(sim.absorption), nextShape: sim.nextShape,
    payloadReady: performance.now() >= sim.payloadReadyAt, shielded: performance.now() < sim.invulnerableUntil,
  }), []);

  const fire = useCallback(() => {
    const sim = simRef.current;
    if (!sim || !launchPayload(sim, LAUNCH_SPEED)) return;
    sim.message = "Projectile committed—watch the torque"; syncHUD(sim);
  }, [syncHUD]);

  const reset = useCallback(() => {
    const old = simRef.current;
    if (old) { old.events.free(); old.world.free(); }
    simRef.current = null;
    setHud(initialHUD);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const createSimulation = async () => {
      await RAPIER.init();
      if (cancelled) return;
      const world = new RAPIER.World({ x: 0, y: 0 });
      world.integrationParameters.dt = 1 / 60;
      const events = new RAPIER.EventQueue(true);
      const core = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinearDamping(.01).setAngularDamping(.012).setAdditionalMass(18));
      const coreCollider = world.createCollider(RAPIER.ColliderDesc.ball(3.1).setDensity(3).setFriction(1).setRestitution(.08).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(28), core);
      const ship = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -25).setRotation(Math.PI / 2).setLinvel(8.2, 0).setLinearDamping(.012).setAngularDamping(1.8).setCcdEnabled(true));
      const shipShape = RAPIER.ColliderDesc.roundConvexHull(new Float32Array([2.1, 0, -.9, -1.15, -1.35, 0, -.9, 1.15]), .22) ?? RAPIER.ColliderDesc.ball(SHIP_RADIUS);
      const shipCollider = world.createCollider(shipShape.setDensity(1.4).setFriction(.55).setRestitution(.12), ship);
      const sim: Sim = { world, events, core, coreCollider, planetRadius: 3.1, ship, shipCollider, mantles: [], blocks: [], groups: [], escapedGroups: new Set(), nextShape: 2, payloadReadyAt: 0, invulnerableUntil: 0, score: 0, rings: 0, escapes: 0, shots: 0, over: false, paused: false, lastTime: performance.now(), accumulator: 0, groupId: 0, flash: 0, message: "Free flight established—thrust, turn, and seed the planet", absorption: null };
      simRef.current = sim; syncHUD(sim);
    };

    createSimulation();
    let lastHud = 0;
    const draw = (sim: Sim) => {
      ctx.clearRect(0, 0, VIEW, VIEW);
      const absorptionProgress = sim.absorption ? Math.min(1, (performance.now() - sim.absorption.started) / sim.absorption.duration) : 0;
      const gradient = ctx.createRadialGradient(VIEW / 2, VIEW / 2, 10, VIEW / 2, VIEW / 2, ARENA * SCALE);
      gradient.addColorStop(0, "#164b70"); gradient.addColorStop(.35, "#0c2b48"); gradient.addColorStop(1, "#061522");
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(VIEW / 2, VIEW / 2, ARENA * SCALE, 0, Math.PI * 2); ctx.fill();

      // The outer rim is the safe navigation boundary; the ship is otherwise free-moving.
      ctx.save(); ctx.translate(VIEW / 2, VIEW / 2); ctx.setLineDash([8, 12]); ctx.strokeStyle = "rgba(122,231,255,.24)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, ARENA * SCALE, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      const coreWorld = sim.core.translation(); const coreScreen = screen(coreWorld.x, coreWorld.y);
      ctx.save(); ctx.translate(coreScreen.x, coreScreen.y);
      const field = captureField(sim); const charge = bandCharge(sim); const atmosphereRadius = ((field.inner + field.outer) / 2) * SCALE;
      ctx.setLineDash([]); ctx.lineWidth = (field.outer - field.inner) * SCALE * .72; ctx.strokeStyle = `rgba(${Math.round(91 + charge * 110)},${Math.round(125 + charge * 120)},255,${.11 + charge * .7})`; ctx.shadowColor = "#8decff"; ctx.shadowBlur = 3 + charge * 30; ctx.beginPath(); ctx.arc(0, 0, atmosphereRadius, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = `rgba(190,237,255,${.42 + charge * .5})`; ctx.textAlign = "center"; ctx.font = "800 9px Arial"; ctx.fillText(`CAPTURE FIELD  ${Math.round(charge * 100)}%`, 0, -atmosphereRadius - 13);
      ctx.restore();

      // Preview and projectile share the ship's exact muzzle transform and inherited velocity.
      const shipState = shipTransform(sim); const shipVelocity = sim.ship.linvel();
      if (performance.now() >= sim.payloadReadyAt) {
        let px = shipState.muzzle.x, py = shipState.muzzle.y;
        let vx = shipVelocity.x + Math.cos(shipState.direction) * LAUNCH_SPEED;
        let vy = shipVelocity.y + Math.sin(shipState.direction) * LAUNCH_SPEED;
        ctx.beginPath(); const first = screen(px, py); ctx.moveTo(first.x, first.y);
        for (let i = 0; i < 90; i++) { const r = Math.hypot(px, py) || 1; const f = gravityStrength(r); const drag = Math.max(0, (18 - r) / 18) * 1.8; vx += ((-px / r) * f - vx * drag) * .035; vy += ((-py / r) * f - vy * drag) * .035; px += vx * .035; py += vy * .035; const p = screen(px, py); ctx.lineTo(p.x, p.y); }
        ctx.strokeStyle = "rgba(125,234,255,.33)"; ctx.lineWidth = 2; ctx.setLineDash([3, 8]); ctx.stroke(); ctx.setLineDash([]);
      }

      // Intact tetrominoes get visible ice bonds; only an impact can remove them.
      sim.groups.filter((group) => !group.fractured).forEach((group) => {
        for (let i = 0; i < group.blocks.length; i++) for (let j = i + 1; j < group.blocks.length; j++) {
          if (!group.blocks[i].body || !group.blocks[j].body) continue;
          const a = group.blocks[i].body!.translation(); const b = group.blocks[j].body!.translation();
          if (Math.hypot(a.x - b.x, a.y - b.y) > BLOCK * 2.5) continue;
          const ap = screen(a.x, a.y); const bp = screen(b.x, b.y); ctx.strokeStyle = "rgba(185,204,213,.46)"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(ap.x, ap.y); ctx.lineTo(bp.x, bp.y); ctx.stroke();
        }
      });

      sim.blocks.filter((block) => !block.removed).forEach((block) => {
        const pose = blockPose(block, sim.core); let renderPosition = pose.position; const size = BLOCK * SCALE;
        const beingAbsorbed = Boolean(sim.absorption?.blocks.includes(block));
        if (beingAbsorbed && sim.absorption) { const dx = pose.position.x - coreWorld.x; const dy = pose.position.y - coreWorld.y; const angle = Math.atan2(dy, dx); const targetRadius = (sim.planetRadius + compressedPlanetRadius(sim.planetRadius, sim.absorption.blocks.length)) / 2; const eased = 1 - Math.pow(1 - absorptionProgress, 3); const radius = Math.hypot(dx, dy) + (targetRadius - Math.hypot(dx, dy)) * eased; renderPosition = { x: coreWorld.x + Math.cos(angle) * radius, y: coreWorld.y + Math.sin(angle) * radius }; }
        const p = screen(renderPosition.x, renderPosition.y);
        ctx.save(); ctx.globalAlpha = beingAbsorbed ? 1 - absorptionProgress * .82 : 1; ctx.translate(p.x, p.y); ctx.rotate(pose.rotation); if (beingAbsorbed) ctx.scale(1 - absorptionProgress * .82, 1 - absorptionProgress * .82); ctx.shadowBlur = block.attached ? 4 : 7; ctx.shadowColor = "rgba(145,170,182,.45)"; ctx.fillStyle = beingAbsorbed ? "#e8f0f2" : block.color;
        traceIce(ctx, size, block.variant); ctx.fill();
        ctx.strokeStyle = "rgba(225,235,239,.48)"; ctx.lineWidth = 1.2; ctx.stroke(); ctx.fillStyle = "rgba(245,250,252,.09)"; ctx.fillRect(-BLOCK * SCALE + 3, -BLOCK * SCALE + 3, BLOCK * 1.35 * SCALE, 3); ctx.restore();
      });

      const coreP = screen(coreWorld.x, coreWorld.y); ctx.save(); ctx.translate(coreP.x, coreP.y); ctx.rotate(sim.core.rotation());
      ctx.shadowBlur = 7; ctx.shadowColor = "rgba(120,140,150,.38)"; ctx.fillStyle = "#747f85"; ctx.beginPath(); ctx.arc(0, 0, sim.planetRadius * SCALE, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 24 + Math.sin(performance.now() / 180) * 5; ctx.shadowColor = "#74eaff"; ctx.fillStyle = "#f8ffff"; ctx.beginPath(); ctx.arc(0, 0, 3.05 * SCALE, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; sim.mantles.forEach((mantle) => { ctx.strokeStyle = mantle.color; ctx.lineWidth = (mantle.outer - mantle.inner) * SCALE; ctx.beginPath(); ctx.arc(0, 0, ((mantle.inner + mantle.outer) / 2) * SCALE, 0, Math.PI * 2); ctx.stroke(); });
      ctx.shadowBlur = 0; ctx.fillStyle = "rgba(79,190,220,.22)"; ctx.beginPath(); ctx.ellipse(-10, -7, 7, 4, -.35, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(12, 9, 4, 6, .4, 0, Math.PI * 2); ctx.fill(); ctx.restore();

      const shipPoint = screen(shipState.position.x, shipState.position.y); const thrusting = keysRef.current.has("w") || keysRef.current.has("ArrowUp");
      ctx.save(); ctx.translate(shipPoint.x, shipPoint.y); ctx.rotate(shipState.direction); ctx.shadowBlur = 16; ctx.shadowColor = "#65ddff";
      if (thrusting) { ctx.fillStyle = "rgba(109,224,255,.78)"; ctx.beginPath(); ctx.moveTo(-12, -7); ctx.lineTo(-30 - Math.random() * 9, 0); ctx.lineTo(-12, 7); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = "#8fa9b5"; ctx.beginPath(); ctx.moveTo(24, 0); ctx.lineTo(-12, -13); ctx.lineTo(-7, 0); ctx.lineTo(-12, 13); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(226,242,247,.72)"; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = "#dffaff"; ctx.beginPath(); ctx.arc(4, 0, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();

      if (performance.now() < sim.invulnerableUntil) { const pulse = 21 + Math.sin(performance.now() / 65) * 2; ctx.save(); ctx.translate(shipPoint.x, shipPoint.y); ctx.strokeStyle = "rgba(124,236,255,.88)"; ctx.lineWidth = 2.5; ctx.shadowBlur = 18; ctx.shadowColor = "#6fe8ff"; ctx.beginPath(); ctx.arc(0, 0, pulse, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }

      // The next bonded tetromino is visibly loaded on the muzzle.
      const loadedColor = ICE_COLOR;
      if (performance.now() >= sim.payloadReadyAt) SHAPES[sim.nextShape].forEach(([gx, gy], index) => {
        const offset = rotate(gx * BLOCK * 2.05, gy * BLOCK * 2.05, shipState.direction); const p = screen(shipState.muzzle.x + offset.x, shipState.muzzle.y + offset.y);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(shipState.direction); ctx.shadowBlur = 6; ctx.shadowColor = "rgba(145,170,182,.45)"; ctx.fillStyle = loadedColor; traceIce(ctx, BLOCK * SCALE, index % 3); ctx.fill(); ctx.strokeStyle = "rgba(225,235,239,.55)"; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();
      });

      if (sim.absorption) {
        const outer = compressedPlanetRadius(sim.planetRadius, sim.absorption.blocks.length); const radius = (sim.planetRadius + outer) / 2 * SCALE;
        ctx.save(); ctx.translate(coreScreen.x, coreScreen.y); ctx.strokeStyle = `rgba(205,235,240,${.22 + absorptionProgress * .78})`; ctx.lineWidth = Math.max(3, (outer - sim.planetRadius) * SCALE * absorptionProgress); ctx.shadowBlur = 5 + absorptionProgress * 16; ctx.shadowColor = "#9cc6cf"; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowBlur = 0; ctx.textAlign = "center"; ctx.fillStyle = `rgba(225,244,247,${.45 + absorptionProgress * .55})`; ctx.font = "800 10px Arial"; ctx.fillText("MANTLE FUSING", 0, -radius - 12); ctx.restore();
      }

      if (sim.flash > performance.now()) { ctx.fillStyle = `rgba(181,241,255,${Math.max(0, (sim.flash - performance.now()) / 400)})`; ctx.fillRect(0, 0, VIEW, VIEW); }
    };

    const step = (sim: Sim, now: number) => {
      const dt = Math.min(.035, (now - sim.lastTime) / 1000); sim.lastTime = now;
      if (!sim.paused && !sim.over) {
        const keys = keysRef.current;
        const turn = (keys.has("ArrowRight") || keys.has("d") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("a") ? 1 : 0);
        const drive = (keys.has("ArrowUp") || keys.has("w") ? 1 : 0) - (keys.has("ArrowDown") || keys.has("s") ? .55 : 0);
        sim.accumulator += dt;
        while (sim.accumulator >= 1 / 60) {
          sim.blocks.forEach((block) => {
            if (!block.body || block.attached || block.removed) return;
            const t = block.body.translation(); const r = Math.hypot(t.x, t.y) || 1; const v = block.body.linvel();
            const mass = block.body.mass(); const force = gravityStrength(r) * mass; const innerDrag = Math.max(0, (18 - r) / 18) * 1.8 * mass;
            block.body.resetForces(true);
            block.body.addForce({ x: -t.x / r * force - v.x * innerDrag, y: -t.y / r * force - v.y * innerDrag }, true);
          });
          const corePos = sim.core.translation(); const coreRadius = Math.hypot(corePos.x, corePos.y);
          sim.core.resetForces(true);
          if (coreRadius > .02) { const coreVelocity = sim.core.linvel(); const coreMass = sim.core.mass(); const restoring = gravityStrength(coreRadius) * coreMass * .45; sim.core.addForce({ x: -corePos.x / coreRadius * restoring - coreVelocity.x * .025 * coreMass, y: -corePos.y / coreRadius * restoring - coreVelocity.y * .025 * coreMass }, true); }
          const shipPosition = sim.ship.translation(); const shipRadius = Math.hypot(shipPosition.x, shipPosition.y) || 1; const shipMass = sim.ship.mass(); const shipGravity = gravityStrength(shipRadius) * shipMass * .16; const heading = sim.ship.rotation();
          sim.ship.resetForces(true); sim.ship.setAngvel(turn * 1.65, true);
          sim.ship.addForce({ x: -shipPosition.x / shipRadius * shipGravity + Math.cos(heading) * drive * 8.5 * shipMass, y: -shipPosition.y / shipRadius * shipGravity + Math.sin(heading) * drive * 8.5 * shipMass }, true);
          sim.world.step(sim.events); sim.accumulator -= 1 / 60;
        }

        const shipPosition = sim.ship.translation(); const corePosition = sim.core.translation();
        const hitCore = Math.hypot(shipPosition.x - corePosition.x, shipPosition.y - corePosition.y) < sim.planetRadius + SHIP_RADIUS;
        const hitAccretion = sim.blocks.some((block) => block.attached && Math.hypot(shipPosition.x - blockPose(block, sim.core).position.x, shipPosition.y - blockPose(block, sim.core).position.y) < SHIP_RADIUS + BLOCK);
        if (now >= sim.payloadReadyAt && !sim.absorption) {
          const payload = shipTransform(sim); const carriedHit = SHAPES[sim.nextShape].some(([gx, gy]) => {
            const offset = rotate(gx * BLOCK * 2.05, gy * BLOCK * 2.05, payload.direction); const x = payload.muzzle.x + offset.x; const y = payload.muzzle.y + offset.y;
            if (Math.hypot(x - corePosition.x, y - corePosition.y) < sim.planetRadius + BLOCK) return true;
            return sim.blocks.some((block) => !block.removed && Math.hypot(x - blockPose(block, sim.core).position.x, y - blockPose(block, sim.core).position.y) < BLOCK * 1.9);
          });
          if (carriedHit && launchPayload(sim, 0, true, now)) { sim.payloadReadyAt = now + 1100; sim.invulnerableUntil = now + 1100; sim.flash = now + 160; sim.message = "Payload sheared free—hull shielding active"; }
        }
        if (now >= sim.invulnerableUntil && (hitCore || hitAccretion)) { sim.over = true; sim.message = "Hull breach—the terraforming ship struck the growing planetoid"; }
        if (Math.hypot(shipPosition.x, shipPosition.y) > ARENA + 4) { sim.over = true; sim.message = "Navigation lost—the terraforming ship escaped the well"; }

        const fracturedGroups = new Set<number>();
        const hardHits: Array<{ attached: Block; incoming: Block }> = [];
        sim.events.drainContactForceEvents((event) => {
          const force = event.maxForceMagnitude();
          const blockA = sim.blocks.find((item) => item.collider?.handle === event.collider1());
          const blockB = sim.blocks.find((item) => item.collider?.handle === event.collider2());
          if (!sim.absorption && force > 290 && blockA?.group !== blockB?.group) {
            if (blockA?.attached && blockB?.body) hardHits.push({ attached: blockA, incoming: blockB });
            if (blockB?.attached && blockA?.body) hardHits.push({ attached: blockB, incoming: blockA });
          }
          if (force < 130) return;
          if (blockA && blockB && blockA.group === blockB.group) return;
          if (blockA && blockA.group > 0) fracturedGroups.add(blockA.group);
          if (blockB && blockB.group > 0) fracturedGroups.add(blockB.group);
        });
        fracturedGroups.forEach((id) => {
          const group = sim.groups.find((g) => g.id === id); if (!group || group.fractured) return;
          const bodies = group.blocks.map((block) => block.body).filter((body): body is RigidBody => Boolean(body));
          const totalMass = bodies.reduce((sum, body) => sum + body.mass(), 0) || 1;
          const centerVelocity = bodies.reduce((sum, body) => ({ x: sum.x + body.linvel().x * body.mass(), y: sum.y + body.linvel().y * body.mass() }), { x: 0, y: 0 });
          centerVelocity.x /= totalMass; centerVelocity.y /= totalMass;
          group.joints.forEach((joint) => { try { sim.world.removeImpulseJoint(joint, true); } catch {} });
          // Preserve group momentum but dissipate constraint strain instead of turning it into an explosion.
          bodies.forEach((body) => { const velocity = body.linvel(); body.setLinvel({ x: centerVelocity.x + (velocity.x - centerVelocity.x) * .18, y: centerVelocity.y + (velocity.y - centerVelocity.y) * .18 }, true); body.setAngvel(body.angvel() * .25, true); });
          group.joints = []; group.fractured = true; sim.flash = now + 220; sim.message = "Ice bonds cracked—impact energy dissipated"; sim.score += 35;
        });

        if (hardHits.length) {
          const released = new Set<Block>();
          hardHits.forEach(({ attached, incoming }) => {
            if (!attached.attached || !attached.local || !incoming.body) return;
            const incomingVelocity = incoming.body.linvel(); const coreVelocity = sim.core.linvel();
            const boost = { x: (incomingVelocity.x - coreVelocity.x) * .08, y: (incomingVelocity.y - coreVelocity.y) * .08 };
            const nearby = sim.blocks.filter((candidate) => candidate.attached && candidate.local && Math.hypot(candidate.local.x - attached.local!.x, candidate.local.y - attached.local!.y) < BLOCK * 2.8).slice(0, 4);
            nearby.forEach((block) => { if (!released.has(block)) { unfreezeBlock(sim, block, now, boost); released.add(block); } });
          });
          if (released.size) { releaseDisconnectedIce(sim, now); sim.message = `Hard impact released ${released.size} frozen chunk${released.size === 1 ? "" : "s"}`; }
        }

        sim.blocks.forEach((block) => {
          if (block.attached || block.removed || !block.body) return;
          const body = block.body; const t = body.translation(); const corePos = sim.core.translation(); const dx = t.x - corePos.x; const dy = t.y - corePos.y; const r = Math.hypot(dx, dy); const v = body.linvel(); const coreV = sim.core.linvel();
          const arenaRadius = Math.hypot(t.x, t.y);
          if (arenaRadius > ARENA + 5) {
            sim.world.removeRigidBody(body); block.body = null; block.collider = null; block.removed = true;
            if (block.group > 0 && !sim.escapedGroups.has(block.group)) { sim.escapedGroups.add(block.group); sim.escapes++; }
            sim.message = "A projectile shed ice into the void"; return;
          }
          const touchingAsteroid = r < sim.planetRadius + BLOCK * 1.55 || sim.blocks.some((other) => {
            if (!other.attached) return false;
            const otherPos = blockPose(other, sim.core).position;
            return Math.hypot(t.x - otherPos.x, t.y - otherPos.y) < BLOCK * 2.45;
          });
          if (performance.now() - block.born > 1100 && touchingAsteroid && Math.hypot(v.x - coreV.x, v.y - coreV.y) < 2.2) {
            const local = rotate(dx, dy, -sim.core.rotation());
            const localRotation = body.rotation() - sim.core.rotation();
            try {
              // Settled ice becomes collider geometry on one compound rigid body.
              const compound = iceCollider(block.variant).setTranslation(local.x, local.y).setRotation(localRotation).setDensity(.85).setFriction(1).setRestitution(.04)
                .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(28);
              sim.world.removeRigidBody(body); block.body = null; block.collider = sim.world.createCollider(compound, sim.core);
              block.local = local; block.localRotation = localRotation; block.attached = true;
              if (!block.settledOnce) { block.settledOnce = true; sim.score += 10; }
            } catch {}
          }
        });
        sim.blocks = sim.blocks.filter((b) => !b.removed);

        // Condense the complete angular envelope into a permanent mantle.
        if (sim.absorption && now - sim.absorption.started >= sim.absorption.duration) {
          const completed = sim.absorption;
          completed.blocks.forEach((block) => { if (block.collider) try { sim.world.removeCollider(block.collider, true); } catch {} block.removed = true; });
          sim.blocks = sim.blocks.filter((block) => !block.removed);
          const oldRadius = sim.planetRadius;
          sim.planetRadius = compressedPlanetRadius(oldRadius, completed.blocks.length);
          sim.mantles.push({ inner: oldRadius, outer: sim.planetRadius, color: MANTLE_COLORS[sim.rings % MANTLE_COLORS.length] });
          sim.world.removeCollider(sim.coreCollider, true);
          sim.coreCollider = sim.world.createCollider(RAPIER.ColliderDesc.ball(sim.planetRadius).setDensity(3).setFriction(1).setRestitution(.06)
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(28), sim.core);
          sim.rings++; sim.score += 1200; sim.absorption = null;
          releaseDisconnectedIce(sim, now);
          sim.message = "New ice mantle fused—volatiles released into the atmosphere";
        }

        if (!sim.absorption) {
          const coverage = atmosphereCoverage(sim);
          const field = captureField(sim);
          const corePos = sim.core.translation();
          if (coverage.complete) {
            const absorbed = sim.blocks.filter((b) => { const t = blockPose(b, sim.core).position; const r = Math.hypot(t.x - corePos.x, t.y - corePos.y); return b.attached && r >= field.inner && r < field.outer; });
            sim.absorption = { blocks: absorbed, started: now, duration: 1150 };
            sim.message = "Angular envelope complete—mantle fusing";
          }
        }
        if (Math.hypot(sim.core.translation().x, sim.core.translation().y) > 25.5) { sim.over = true; sim.message = "The asteroid escaped the gravity well"; }
        if (sim.escapes >= 3) { sim.over = true; sim.message = "Orbit lost: three fragments escaped"; }
      }
      draw(sim);
      if (now - lastHud > 120) { syncHUD(sim); lastHud = now; }
      frameRef.current = requestAnimationFrame(loop);
    };
    const loop = (now: number) => { const sim = simRef.current; if (sim) step(sim, now); else frameRef.current = requestAnimationFrame(loop); };
    frameRef.current = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(frameRef.current); const sim = simRef.current; if (sim) { sim.events.free(); sim.world.free(); simRef.current = null; } };
  }, [syncHUD, revision]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => { const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; keysRef.current.add(key); if (event.key === " ") { event.preventDefault(); fire(); } if (key === "p") { const sim = simRef.current; if (sim) { sim.paused = !sim.paused; sim.message = sim.paused ? "Time frozen" : "Orbit resumed"; syncHUD(sim); } } };
    const up = (event: KeyboardEvent) => keysRef.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [fire, syncHUD]);

  const commandShip = (kind: "left" | "right" | "thrust" | "reverse") => {
    const sim = simRef.current; if (!sim || sim.over) return;
    if (kind === "left" || kind === "right") { sim.ship.setRotation(sim.ship.rotation() + (kind === "left" ? -.18 : .18), true); sim.ship.setAngvel(0, true); }
    else { const scale = kind === "thrust" ? 1.4 : -.8; const angle = sim.ship.rotation(); sim.ship.applyImpulse({ x: Math.cos(angle) * scale * sim.ship.mass(), y: Math.sin(angle) * scale * sim.ship.mass() }, true); }
    syncHUD(sim);
  };
  const pause = () => { const sim = simRef.current; if (!sim || sim.over) return; sim.paused = !sim.paused; sim.message = sim.paused ? "Time frozen" : "Orbit resumed"; syncHUD(sim); };

  return <main className={styles.page}>
    <header><div><span>Free-flight terraforming mission</span><h1>GLACIER <b>WELL</b></h1></div><p>Pilot by inertia, launch cometary ice, and grow a world—without letting your ship become part of it.</p></header>
    <section className={styles.layout}>
      <aside className={styles.stats}>
        <div><span>Score</span><strong>{hud.score.toString().padStart(5, "0")}</strong></div>
        <div><span>Ice mantles fused</span><strong>{hud.rings}</strong></div>
        <div><span>Escaped</span><strong className={hud.escapes ? styles.danger : ""}>{hud.escapes} / 3</strong></div>
        <div className={styles.meters}><span>Terraforming record</span>{[0, 1, 2].map((i) => <i key={i} className={i < Math.min(3, hud.rings) ? styles.complete : ""} />)}</div>
      </aside>
      <div className={styles.canvasWrap}>
        <canvas ref={canvasRef} width={VIEW} height={VIEW} aria-label="Orbital physics game canvas" />
        {!hud.ready && <div className={styles.overlay}>INITIALIZING PHYSICS</div>}
        {hud.over && <div className={styles.overlay}><b>MISSION LOST</b><span>{hud.message}</span><button onClick={reset}>Restart mission</button></div>}
        {hud.paused && !hud.over && <div className={styles.overlay}><b>TIME FROZEN</b><button onClick={pause}>Resume</button></div>}
      </div>
      <aside className={styles.telemetry}>
        <div><span>Ship speed</span><strong>{hud.shipSpeed.toFixed(1)}</strong><small>INERTIAL VELOCITY</small></div>
        <div><span>Hull clearance</span><strong className={hud.clearance < 5 ? styles.danger : ""}>{hud.clearance.toFixed(1)}</strong><small>TO PLANET SURFACE</small></div>
        <div><span>Payload impulse</span><strong>{LAUNCH_SPEED}</strong><small>PLUS SHIP VELOCITY</small></div>
        <div><span>Core drift</span><strong className={hud.drift > .68 ? styles.danger : ""}>{Math.min(999, Math.round(hud.drift * 100))}%</strong><small>LOSS AT 100%</small></div>
        <div><span>Capture field</span><strong>{Math.round(hud.bandCharge * 100)}%</strong><small>NO EMPTY ARC OVER 30°</small></div>
        <div><span>Planet radius</span><strong>{hud.planetRadius.toFixed(1)}</strong><small>GROWS WITH EACH MANTLE</small></div>
        <div className={styles.loaded}><span>Loaded payload</span><strong>{hud.payloadReady ? "ON SHIP" : "RELOADING"}</strong><small>{hud.shielded ? "HULL SHIELD ACTIVE" : hud.payloadReady ? "BONDED UNTIL IMPACT" : "NEXT PAYLOAD INBOUND"}</small></div>
      </aside>
    </section>
    <section className={styles.controls}>
      <div><span>STEER</span><button onClick={() => commandShip("left")}>↶ ROTATE</button><button onClick={() => commandShip("right")}>ROTATE ↷</button></div>
      <div><span>DRIVE</span><button onClick={() => commandShip("reverse")}>REVERSE</button><button onClick={() => commandShip("thrust")}>THRUST</button></div>
      <button className={styles.fire} onClick={fire} disabled={!hud.ready || hud.over || hud.absorbing || !hud.payloadReady}>{hud.absorbing ? "ABSORBING" : !hud.payloadReady ? "RELOADING" : "FIRE"} <small>{hud.absorbing ? "OBJECTIVE COMPLETE" : hud.shielded ? "SHIELD ACTIVE" : "SPACE"}</small></button>
      <button className={styles.pause} onClick={pause}>{hud.paused ? "RESUME" : "PAUSE"}</button>
    </section>
    <div className={styles.message}>{hud.message}</div>
    <footer><kbd>A D</kbd> rotate <kbd>W</kbd> thrust <kbd>S</kbd> reverse <kbd>SPACE</kbd> fire <kbd>P</kbd> pause</footer>
  </main>;
}
